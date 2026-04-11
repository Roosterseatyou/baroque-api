#!/usr/bin/env node
import { parentPort, workerData } from "worker_threads";
import * as piecesService from "../services/pieces.service.js";

(async () => {
  try {
    const libraryId = workerData && workerData.libraryId;
    if (!libraryId) throw new Error("libraryId required");
    console.log("[findDuplicatesWorker] starting for library", libraryId);
    const start = Date.now();
    const groups = await piecesService.findDuplicatesInLibrary(libraryId);
    const dur = Date.now() - start;
    console.log(
      "[findDuplicatesWorker] finished for library",
      libraryId,
      "duration_ms=",
      dur,
    );
    // send result back to parent
    parentPort.postMessage({ success: true, groups });
  } catch (err) {
    parentPort.postMessage({
      success: false,
      error: err && err.stack ? err.stack : String(err),
    });
  }
})();
