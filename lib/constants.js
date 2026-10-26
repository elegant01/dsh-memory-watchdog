export const PLUGIN_NAME = 'dsh-memory-watchdog'
export const PLUGIN_VERSION = '0.2.0'

export const GIB = 1024 ** 3

export const SAMPLE_INTERVAL_MS = 5000
export const STALE_AFTER_MS = 15000
export const CONFIRM_SAMPLES = 3

export const WARNING_PCT = 80
export const CRITICAL_PCT = 90
export const CRITICAL_ABS_PCT = 95
export const CRITICAL_AVAIL_BYTES = 2 * GIB
export const WARNING_AVAIL_BYTES = 6 * GIB
export const CRITICAL_EXIT_PCT = 85
export const NORMAL_PCT = 75

export const COOLDOWN_MS = 30 * 60 * 1000
export const IDLE_CONFIRM_CHECKS = 3
export const IDLE_CHECK_INTERVAL_MS = 1000
export const IDLE_GRACE_MS = 1500
export const WAITING_REMINDER_MS = 5 * 60 * 1000
export const NOTICE_LIMIT = 50

export const HANDOFF_VERIFY_TIMEOUT_MS = 15000
export const HANDOFF_FROZEN_TIMEOUT_MS = 8000
export const GO_WAIT_TIMEOUT_MS = 20000
export const HOST_EXIT_WAIT_MS = 10000
export const TARGET_EXIT_WAIT_MS = 5000
export const PORT_RELEASE_WAIT_MS = 10000
export const MEMORY_RECOVERY_WAIT_MS = 30000
export const MEMORY_RECOVERY_PCT = 80
export const MEMORY_RECOVERY_AVAIL_BYTES = 4 * GIB

export const COLLECTOR_MAX_LINE_BYTES = 8192
export const COLLECTOR_MAX_BUFFER_BYTES = 65536
export const COLLECTOR_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
export const COLLECTOR_MALFORMED_RESTART_AFTER = 5
export const POWERSHELL_TIMEOUT_MS = 20000

export const STORE_VERSION = 1
export const CANCELABLE_ACTIONS = new Set(['waiting', 'confirming'])
export const ACTION_STATES = ['observing', 'waiting', 'confirming', 'handoff', 'cooldown']
export const PRESSURE_STATES = ['normal', 'warning', 'critical', 'unknown']

export const HISTORY_LIMIT = 50
export const HISTORY_STATUS_ITEMS = 10

export const ATTRIBUTION_TOP_N = 10
export const ATTRIBUTION_REFRESH_MS = 30000
export const ATTRIBUTION_MAX_AGE_MS = 60000
export const ATTRIBUTION_MIN_TRACK_BYTES = 1 * GIB
export const RESIDENT_WINDOW_MS = 5 * 60 * 1000
export const RESIDENT_NOTICE_MS = 30 * 60 * 1000
export const RESIDENT_GROW_MB = 512
export const RESTART_GATE_MIN_SHARE_PCT = 20

export const SYSTEM_INFO_REFRESH_MS = 5 * 60 * 1000
export const CRASH_HISTORY_REFRESH_MS = 10 * 60 * 1000
export const CRASH_HISTORY_DAYS = 7
export const CRASH_HISTORY_LIMIT = 20

export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000
export const RESUME_QUIET_MS = 20000
export const RESUME_MAX_ATTEMPTS = 2
export const RESUME_ATTEMPT_RESET_MS = 60 * 60 * 1000
export const RESUME_SCAN_DELAYS_MS = [20000, 60000, 180000, 600000]
export const RESUME_MAX_CHILD_INSPECTS = 100
export const RESUME_LEDGER_ITEMS = 10
