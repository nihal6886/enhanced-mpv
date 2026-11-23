"use strict";

const PipelineStage = {
  SNIFFING: "SNIFFING",
  PROBING: "PROBING",
  PREWARMING: "PREWARMING",
  SHADOW_READY: "SHADOW_READY",
  LAUNCHING: "LAUNCHING",
  PLAYING: "PLAYING",
  FAILOVER: "FAILOVER",
  IDLE: "IDLE",
};

const StageOrder = [
  PipelineStage.SNIFFING,
  PipelineStage.PROBING,
  PipelineStage.PREWARMING,
  PipelineStage.SHADOW_READY,
  PipelineStage.LAUNCHING,
  PipelineStage.PLAYING,
];

function canTransition(from, to) {
  if (to === PipelineStage.IDLE || to === PipelineStage.FAILOVER) return true;
  if (from === PipelineStage.IDLE || from === PipelineStage.FAILOVER) return true;
  const fromIdx = StageOrder.indexOf(from);
  const toIdx = StageOrder.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx >= fromIdx;
}

function createInitialPipelineState() {
  return {
    stage: PipelineStage.IDLE,
    candidate: null,
    qualities: [],
    candidates: [],
    relayStats: { bytesPrefetched: 0, segmentsCached: 0, cacheHitRate: 0 },
    frameReady: false,
    prewarmMs: 0,
    launchMs: 0,
    tabId: null,
    startTime: 0,
    updatedAt: Date.now(),
    error: null,
  };
}

function createPipelineStateEvent(state, source = "pipeline") {
  return {
    type: "pipeline:state",
    source,
    timestamp: Date.now(),
    payload: { ...state },
  };
}

function validatePipelineState(state) {
  if (!state || typeof state !== "object") return false;
  if (!Object.values(PipelineStage).includes(state.stage)) return false;
  if (state.candidate && typeof state.candidate !== "object") return false;
  if (!Array.isArray(state.qualities)) return false;
  if (!Array.isArray(state.candidates)) return false;
  if (typeof state.frameReady !== "boolean") return false;
  return true;
}

module.exports = {
  PipelineStage,
  StageOrder,
  canTransition,
  createInitialPipelineState,
  createPipelineStateEvent,
  validatePipelineState,
};