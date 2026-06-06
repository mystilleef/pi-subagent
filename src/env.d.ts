declare namespace NodeJS {
  interface ProcessEnv {
    PATH?: string;
    PI_CODING_AGENT_DIR?: string;
    PI_SUBAGENT_DEPTH?: string;
    PI_SUBAGENT_MAX_DEPTH?: string;
    PI_SUBAGENT_MAX_OUTPUT_BYTES?: string;
    PI_SUBAGENT_MAX_OUTPUT_LINES?: string;
    PI_SUBAGENT_AGENT_END_GRACE_MS?: string;
    PI_SUBAGENT_MAX_STDERR_BYTES?: string;
    PI_SUBAGENT_DEBUG_ENABLED?: string;
  }
}
