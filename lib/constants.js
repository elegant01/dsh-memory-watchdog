export const PLUGIN_NAME = 'dsh-memory-watchdog'
export const PLUGIN_VERSION = '0.9.0'

export const GIB = 1024 ** 3

export const SAMPLE_INTERVAL_MS = 5000
export const STALE_AFTER_MS = 60000
export const STALE_NOTICE_DELAY_MS = 120000
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
export const ATTRIBUTION_GROUP_TOP_N = 10
export const ATTRIBUTION_GROUP_MEMBER_LIMIT = 8
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

export const PLUGIN_WINDOW_MS = 20000
export const PLUGIN_WINDOW_MIN_MS = 5000
export const PLUGIN_WINDOW_MAX_MS = 120000
export const PLUGIN_SAMPLE_MINUTES = 15
export const PLUGIN_SAMPLE_MINUTES_MIN = 5
export const PLUGIN_SAMPLE_MINUTES_MAX = 120
export const PLUGIN_LEAK_MB = 32
export const PLUGIN_LEAK_MB_MIN = 8
export const PLUGIN_LEAK_MB_MAX = 512
export const PLUGIN_MAX_WINDOWS = 48
export const PLUGIN_HISTORY_ITEMS = 24
export const PLUGIN_BASELINE_DELAY_MS = 45000
export const PLUGIN_INVENTORY_REFRESH_MS = 10 * 60 * 1000
export const PLUGIN_TOP_N = 8
export const PLUGIN_MIN_SPAN_MS = 10 * 60 * 1000
export const PLUGIN_STRUCTURAL_GROWTH = 5
export const PLUGIN_SAMPLING_INTERVAL = 4096
export const PLUGIN_FILE = 'plugin-memory.json'
export const PLUGIN_RELOAD_ITEMS = 10
export const HEAP_PROFILE_PREFIX = 'heap-profile-'
export const HEAP_SNAPSHOT_PREFIX = 'heap-snapshot-'
export const SNAPSHOT_DIFF_MAX_BYTES = 1536 * 1024 * 1024
export const SNAPSHOT_DIFF_MAX_NODES = 40_000_000
export const SNAPSHOT_DIFF_TIMEOUT_MS = 120_000
export const SNAPSHOT_DIFF_TOP = 10

export const BLACKBOX_FILE = 'blackbox.json'
export const BLACKBOX_POINTS = 12
export const BLACKBOX_MIN_GAP_MS = 4000

export const CRASH_TRAIL_WINDOW_MS = 2 * 60 * 1000
export const CRASH_TRAIL_POINTS = 12

export const HEAP_NEAR_LIMIT_PCT = 90
export const HEAP_NEAR_RECOVER_PCT = 85
export const HEAP_NEAR_SAMPLES = 3
export const HEAP_EXTERNAL_GROWTH_MB = 200
export const HEAP_EXTERNAL_MARK_MS = 60 * 1000
export const HEAP_EXTERNAL_SPAN_MS = 30 * 60 * 1000
export const HEAP_EXTERNAL_RATE_WINDOW_MS = 60 * 60 * 1000
export const HEAP_EXTERNAL_KEEP_MS = 2 * 60 * 60 * 1000
export const OOM_HEAP_RATIO_PCT = 95
export const OOM_EXTERNAL_MIN_BYTES = 1 * GIB
export const OOM_EXTERNAL_SHARE_PCT = 50

export const SAMPLING_CPU_PCT = 60
export const SAMPLING_COMMIT_GROWTH_MB = 256

export const TREND_FILE = 'trend.json'
export const TREND_DAYS = 14
export const TREND_BUCKET_MS = 60 * 60 * 1000
export const TREND_REFRESH_MS = 10 * 60 * 1000
export const TREND_BINS = 50
export const TREND_BIN_PCT = 2
export const TREND_STATUS_BUCKETS = 96

export const SIGNAL_HANDLE_MS = 5000
export const SIGNAL_HANDLE_POINTS = 12
export const SIGNAL_WARNING_ITEMS = 20
export const SIGNAL_LOOP_RESOLUTION_MS = 20

// Health score: every component is reported with the number it was computed
// from, so the single 0-100 figure never has to be taken on faith.
export const HEALTH_GRADE_GOOD = 90
export const HEALTH_GRADE_FAIR = 75
export const HEALTH_GRADE_POOR = 50
export const HEALTH_LOOP_P99_GOOD_MS = 50
export const HEALTH_LOOP_P99_BAD_MS = 500
export const HEALTH_GROWTH_GOOD_MB_PER_HOUR = 64
export const HEALTH_GROWTH_BAD_MB_PER_HOUR = 512

// Advice list: one ordered, deduplicated list built from every other module.
export const ADVICE_MAX_ITEMS = 8

// Crashpad minidumps are parsed only when the user asks, and only after the
// directory probe says there is something to parse.
export const CRASHPAD_MAX_FILE_BYTES = 512 * 1024 * 1024
export const CRASHPAD_MAX_MODULES = 500
export const CRASHPAD_MAX_MEMORY_ENTRIES = 200_000
export const CRASHPAD_STATUS_FILES = 5

// Renderer heap total reported by the client. This is a total, never a
// per-plugin attribution: the renderer cannot see which plugin allocated.
export const RENDERER_REPORT_MIN_INTERVAL_MS = 30 * 1000
export const RENDERER_STALE_MS = 120 * 1000
export const RENDERER_SANITY_MAX_BYTES = 64 * 1024 * 1024 * 1024
export const HEALTH_RENDERER_WARN_BYTES = 1 * GIB
export const HEALTH_RENDERER_BAD_BYTES = 2 * GIB
