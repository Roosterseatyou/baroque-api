import * as commentsService from "../services/comments.service.js";
import db from "../config/knex.js";

export async function addComment(req, res) {
  try {
    const pieceId = req.params.pieceId;
    const userId = req.user && req.user.id;
    const { content, parentId } = req.body;
    const text = String(content || "").trim();

    if (!text) {
      console.debug(
        `addComment validation failed: empty content, user=${userId} piece=${pieceId} body=${JSON.stringify(req.body)}`,
      );
      return res.status(400).json({ error: "Content required" });
    }
    if (text.length > 250) {
      console.debug(
        `addComment validation failed: content too long (${text.length}), user=${userId} piece=${pieceId} body=${JSON.stringify(req.body).slice(0, 200)}`,
      );
      return res.status(400).json({ error: "Content exceeds 250 characters" });
    }

    // derive organization id and membership to enforce viewer posting rule
    const orgId = await deriveOrgIdForPiece(pieceId);
    let membership = null;
    try {
      if (orgId && userId) {
        membership = await db("organization_memberships")
          .where({ organization_id: orgId, user_id: userId })
          .first();
      }
    } catch (e) {
      console.error(
        "addComment: error looking up membership",
        e && e.stack ? e.stack : e,
      );
    }

    // allow viewers to post top-level comments as requested

    const comment = await commentsService.addComment({
      pieceId,
      userId,
      content: text,
      parentId: parentId || null,
    });
    res.status(201).json(comment);
  } catch (err) {
    console.error("addComment error:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message });
  }
}

export async function getComments(req, res) {
  try {
    const pieceId = req.params.pieceId;
    const comments = await commentsService.getCommentsForPiece(pieceId);
    res.status(200).json(comments);
  } catch (err) {
    console.error("getComments error:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message });
  }
}

export async function updateComment(req, res) {
  try {
    const commentId = req.params.commentId;
    const userId = req.user && req.user.id;
    const { content } = req.body;
    const text = String(content || "").trim();
    if (!text) return res.status(400).json({ error: "Content required" });
    if (text.length > 250)
      return res.status(400).json({ error: "Content exceeds 250 characters" });

    const existing = await db("piece_comments")
      .where({ id: commentId })
      .first();
    if (!existing) return res.status(404).json({ error: "Comment not found" });

    // permission: authors can edit their own; owners/admins/managers can edit any
    const orgId = await deriveOrgIdForPiece(existing.piece_id);
    const membership = await db("organization_memberships")
      .where({ organization_id: orgId, user_id: userId })
      .first();
    const userRole = membership?.role;
    if (
      existing.user_id !== userId &&
      !["owner", "admin", "manager"].includes(userRole)
    ) {
      return res
        .status(403)
        .json({ error: "Insufficient permissions to edit comment" });
    }

    const updated = await commentsService.updateComment(commentId, userId, {
      content: text,
    });
    res.status(200).json(updated);
  } catch (err) {
    console.error("updateComment error:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message });
  }
}

export async function deleteComment(req, res) {
  try {
    const commentId = req.params.commentId;
    const userId = req.user && req.user.id;
    const existing = await db("piece_comments")
      .where({ id: commentId })
      .first();
    if (!existing) return res.status(404).json({ error: "Comment not found" });

    const orgId = await deriveOrgIdForPiece(existing.piece_id);
    const membership = await db("organization_memberships")
      .where({ organization_id: orgId, user_id: userId })
      .first();
    const userRole = membership?.role;
    if (
      existing.user_id !== userId &&
      !["owner", "admin", "manager"].includes(userRole)
    ) {
      return res
        .status(403)
        .json({ error: "Insufficient permissions to delete comment" });
    }

    await commentsService.deleteComment(commentId);
    res.status(204).send();
  } catch (err) {
    console.error("deleteComment error:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message });
  }
}

// helper to derive organization id from piece id
async function deriveOrgIdForPiece(pieceId) {
  const piece = await db("pieces").where({ id: pieceId }).first();
  if (!piece) return null;
  const lib = await db("libraries").where({ id: piece.library_id }).first();
  if (!lib) return null;
  return lib.organization_id;
}
