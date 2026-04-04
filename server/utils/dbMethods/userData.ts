import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { articles, attachments, rotes } from '../../drizzle/schema';
import db from '../drizzle';
import { DatabaseError } from './common';

export async function statistics(authorid: string): Promise<any> {
  try {
    const [noteCountResult, attachmentsList, articleCountResult] = await Promise.all([
      db.select({ count: count() }).from(rotes).where(eq(rotes.authorid, authorid)),
      db.select().from(attachments).where(eq(attachments.userid, authorid)),
      db.select({ count: count() }).from(articles).where(eq(articles.authorId, authorid)),
    ]);

    return {
      noteCount: noteCountResult[0]?.count || 0,
      attachmentsCount: attachmentsList.length,
      articleCount: articleCountResult[0]?.count || 0,
    };
  } catch (error) {
    throw new DatabaseError('Failed to get user statistics', error);
  }
}

export async function exportData(authorid: string): Promise<any> {
  try {
    // 使用 relational query API 获取关联数据
    const [notes, userArticles] = await Promise.all([
      db.query.rotes.findMany({
        where: (rotes, { eq }) => eq(rotes.authorid, authorid),
        with: {
          author: {
            columns: {
              username: true,
              nickname: true,
              avatar: true,
            },
          },
          article: true,
          attachments: true,
          reactions: {
            with: {
              user: {
                columns: {
                  username: true,
                  nickname: true,
                  avatar: true,
                },
              },
            },
          },
        },
      }),
      db.select().from(articles).where(eq(articles.authorId, authorid)),
    ]);
    return { notes, articles: userArticles };
  } catch (error) {
    throw new DatabaseError('Failed to export user data', error);
  }
}

export async function getHeatMap(userId: string, startDate: string, endDate: string): Promise<any> {
  try {
    const rotesList = await db
      .select()
      .from(rotes)
      .where(
        and(
          eq(rotes.authorid, userId),
          gte(rotes.createdAt, new Date(startDate)),
          lte(rotes.createdAt, new Date(endDate))
        )
      );

    if (rotesList.length === 0) {
      return {};
    }

    return rotesList.reduce((acc: any, item: any) => {
      const date = item.createdAt.toISOString().split('T')[0];
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {});
  } catch (error) {
    throw new DatabaseError('Failed to generate heatmap data', error);
  }
}

export async function getMyTags(userid: string): Promise<any> {
  try {
    const tagCounts = await db
      .select({
        name: sql<string>`unnest(${rotes.tags})`,
        count: sql<number>`count(*)::int`,
      })
      .from(rotes)
      .where(eq(rotes.authorid, userid))
      .groupBy(sql`unnest(${rotes.tags})`)
      .orderBy(sql`count(*) desc`);
    return tagCounts;
  } catch (error) {
    throw new DatabaseError('Failed to get user tags', error);
  }
}

export async function importData(userId: string, data: any): Promise<any> {
  const { notes } = data;

  if (!Array.isArray(notes)) {
    throw new Error('Invalid data format: notes must be an array');
  }

  const importedArticles = Array.from(
    new Map(
      [
        ...(Array.isArray(data.articles) ? data.articles : []),
        ...notes
          .map((note: any) => note?.article)
          .filter((article: unknown): article is Record<string, any> => !!article),
      ]
        .filter(
          (article: any) => typeof article?.id === 'string' && typeof article?.content === 'string'
        )
        .map((article: any) => [article.id, article])
    ).values()
  );

  try {
    let noteCreatedCount = 0;
    let noteUpdatedCount = 0;
    let articleCreatedCount = 0;
    let articleUpdatedCount = 0;
    let attachmentCreatedCount = 0;
    let attachmentUpdatedCount = 0;
    let attachmentTotalCount = 0;

    await db.transaction(async (tx) => {
      for (const article of importedArticles) {
        const existingArticle = await tx.query.articles.findFirst({
          where: eq(articles.id, article.id),
        });

        if (existingArticle && existingArticle.authorId !== userId) {
          throw new Error(
            `Security violation: Cannot update article ${article.id} owned by another user`
          );
        }

        if (existingArticle) {
          articleUpdatedCount++;
        } else {
          articleCreatedCount++;
        }

        const articleData = {
          ...article,
          authorId: userId,
          createdAt: article.createdAt ? new Date(article.createdAt) : new Date(),
          updatedAt: article.updatedAt ? new Date(article.updatedAt) : new Date(),
        };
        delete articleData.author;
        delete articleData.rotes;
        delete articleData.title;
        delete articleData.summary;

        await tx.insert(articles).values(articleData).onConflictDoUpdate({
          target: articles.id,
          set: articleData,
        });
      }

      const articleIds = Array.from(
        new Set(
          notes
            .map((note: any) =>
              typeof note?.articleId === 'string' ? note.articleId : note?.article?.id
            )
            .filter((articleId: unknown): articleId is string => typeof articleId === 'string')
        )
      );
      const ownedArticles =
        articleIds.length > 0
          ? await tx
              .select({ id: articles.id })
              .from(articles)
              .where(and(inArray(articles.id, articleIds), eq(articles.authorId, userId)))
          : [];
      const ownedArticleIds = new Set(ownedArticles.map((article) => article.id));

      // 检查并在需要时创建默认附件（如果逻辑需要，这里暂时跳过）

      if (notes && notes.length > 0) {
        for (const note of notes) {
          // 1. 安全检查：如果笔记已存在，检查所有权
          // 注意：exportData 中使用的是 db.query.rotes.findMany
          // 这里使用 tx.query.rotes.findFirst
          const existingNote = await tx.query.rotes.findFirst({
            where: eq(rotes.id, note.id),
          });

          if (existingNote) {
            if (existingNote.authorid !== userId) {
              // 严格模式：报错
              throw new Error(
                `Security violation: Cannot update note ${note.id} owned by another user`
              );
            }
            noteUpdatedCount++;
          } else {
            noteCreatedCount++;
          }

          // 2. 准备笔记数据
          const resolvedArticleId =
            typeof note.articleId === 'string'
              ? note.articleId
              : typeof note.article?.id === 'string'
                ? note.article.id
                : null;

          const noteData = {
            ...note,
            authorid: userId, // 强制归属
            articleId:
              typeof resolvedArticleId === 'string' && ownedArticleIds.has(resolvedArticleId)
                ? resolvedArticleId
                : null,
            updatedAt: new Date(),
            // createdAt 保持原样或重置，这里保留原样如果存在
            createdAt: note.createdAt ? new Date(note.createdAt) : new Date(),
          };

          // 移除关联对象
          delete noteData.author;
          delete noteData.article;
          delete noteData.articleIds;
          delete noteData.attachments;
          delete noteData.reactions;
          delete noteData.linkPreviews;
          delete noteData.changes;

          // 3. Upsert
          await tx.insert(rotes).values(noteData).onConflictDoUpdate({
            target: rotes.id,
            set: noteData,
          });

          // 4. 处理附件
          if (Array.isArray(note.attachments)) {
            for (const attachment of note.attachments) {
              attachmentTotalCount++;

              const existingAttachment = await tx.query.attachments.findFirst({
                where: eq(attachments.id, attachment.id),
              });

              if (existingAttachment && existingAttachment.userid !== userId) {
                throw new Error(
                  `Security violation: Cannot update attachment ${attachment.id} owned by another user`
                );
              }

              if (existingAttachment) {
                attachmentUpdatedCount++;
              } else {
                attachmentCreatedCount++;
              }

              const attachmentData = {
                ...attachment,
                userid: userId, // 强制归属
                roteid: note.id,
                updatedAt: new Date(),
                createdAt: attachment.createdAt ? new Date(attachment.createdAt) : new Date(),
              };
              delete attachmentData.rote;
              delete attachmentData.user;

              await tx.insert(attachments).values(attachmentData).onConflictDoUpdate({
                target: attachments.id,
                set: attachmentData,
              });
            }
          }
        }
      }
    });

    return {
      count: notes.length,
      created: noteCreatedCount,
      updated: noteUpdatedCount,
      notes: {
        total: notes.length,
        created: noteCreatedCount,
        updated: noteUpdatedCount,
      },
      articles: {
        total: importedArticles.length,
        created: articleCreatedCount,
        updated: articleUpdatedCount,
      },
      attachments: {
        total: attachmentTotalCount,
        created: attachmentCreatedCount,
        updated: attachmentUpdatedCount,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Security violation')) {
      throw new DatabaseError(error.message, error);
    }
    throw new DatabaseError('Failed to import user data', error);
  }
}
