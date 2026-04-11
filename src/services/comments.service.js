import db from "../config/knex.js";
import { generateUUID } from "../utils/uuid.js";

export async function addComment({
  pieceId,
  userId,
  content,
  parentId = null,
}) {
  const id = generateUUID();
  await db("piece_comments").insert({
    id,
    piece_id: pieceId,
    user_id: userId,
    content,
    parent_id: parentId,
  });
  const comment = await db("piece_comments").where({ id }).first();
  const user = await db("users").where({ id: comment.user_id }).first();
  return {
    id: comment.id,
    piece_id: comment.piece_id,
    parent_id: comment.parent_id,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      discriminator: user.discriminator,
    },
    content: comment.content,
    created_at: comment.created_at,
  };
}

export async function getCommentsForPiece(pieceId) {
  const rows = await db("piece_comments")
    .where({ piece_id: pieceId })
    .orderBy("created_at", "asc");
  if (rows.length === 0) return [];
  const userIds = rows.map((r) => r.user_id);
  const users = await db("users")
    .whereIn("id", userIds)
    .select("id", "name", "username", "discriminator");
  const usersById = {};
  users.forEach((u) => (usersById[u.id] = u));
  return rows.map((r) => ({
    id: r.id,
    piece_id: r.piece_id,
    parent_id: r.parent_id || null,
    user: usersById[r.user_id] || null,
    content: r.content,
    created_at: r.created_at,
  }));
}

export async function updateComment(commentId, userId, { content }) {
  // allow update; responsibility for permission checks belongs to controller
  await db("piece_comments")
    .where({ id: commentId })
    .update({ content, updated_at: db.fn.now() });
  const comment = await db("piece_comments").where({ id: commentId }).first();
  const user = await db("users").where({ id: comment.user_id }).first();
  return {
    id: comment.id,
    piece_id: comment.piece_id,
    parent_id: comment.parent_id || null,
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      discriminator: user.discriminator,
    },
    content: comment.content,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export async function deleteComment(commentId) {
  await db("piece_comments").where({ id: commentId }).del();
}
