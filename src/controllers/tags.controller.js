import * as tagsService from "../services/tags.service.js";

export async function createTag(req, res) {
  try {
    const { name } = req.body;
    const libraryId = req.params.libraryId;
    const tag = await tagsService.createTag({ libraryId, name });
    res.status(201).json(tag);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

export async function getTags(req, res) {
  try {
    const libraryId = req.params.libraryId;
    const tags = await tagsService.getTagsForLibrary(libraryId);
    res.status(200).json(tags);
  } catch (error) {
    console.error(
      "Error in getTags:",
      error && error.stack ? error.stack : error,
    );
    res.status(500).json({ message: "Internal server error" });
  }
}

export async function attachTag(req, res) {
  try {
    const { tagId } = req.body;
    const pieceId = req.params.pieceId;
    const result = await tagsService.attachTagToPiece({ pieceId, tagId });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

export async function detachTag(req, res) {
  try {
    const { tagId } = req.body;
    const pieceId = req.params.pieceId;
    await tagsService.detachTagFromPiece({ pieceId, tagId });
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

export async function getTagsForPiece(req, res) {
  try {
    const pieceId = req.params.pieceId;
    const tags = await tagsService.getTagsForPiece(pieceId);
    res.status(200).json(tags);
  } catch (error) {
    console.error(
      "Error in getTagsForPiece:",
      error && error.stack ? error.stack : error,
    );
    res.status(500).json({ message: "Internal server error" });
  }
}

export async function updateTag(req, res) {
  try {
    const libraryId = req.params.libraryId;
    const tagId = req.params.tagId;
    const { name } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: "name is required" });
    const tag = await tagsService.updateTag({
      libraryId,
      tagId,
      name: name.trim(),
    });
    if (!tag) return res.status(404).json({ error: "Tag not found" });
    res.status(200).json(tag);
  } catch (error) {
    console.error("Error updating tag:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
