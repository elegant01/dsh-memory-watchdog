import z from '@deepseek-ai/schemastery'
import { GuardRuntime } from './runtime.js'
import { registerRoutes } from './routes.js'
import { PLUGIN_NAME } from './constants.js'
import { THRESHOLD_LIMITS } from './thresholds.js'

export const name = PLUGIN_NAME
export const inject = ['connection']

export const Config = z
  .object({
    warningPct: z
      .number()
      .min(THRESHOLD_LIMITS.warningPct.min)
      .max(THRESHOLD_LIMITS.warningPct.max)
      .step(THRESHOLD_LIMITS.warningPct.step)
      .default(THRESHOLD_LIMITS.warningPct.default)
      .volatile()
      .description('Commit charge percentage that raises a "warning". Default 80.'),
    criticalPct: z
      .number()
      .min(THRESHOLD_LIMITS.criticalPct.min)
      .max(THRESHOLD_LIMITS.criticalPct.max)
      .step(THRESHOLD_LIMITS.criticalPct.step)
      .default(THRESHOLD_LIMITS.criticalPct.default)
      .volatile()
      .description('Commit charge percentage that raises a "critical" alert. Default 90. Always kept above the warning threshold.'),
    criticalAvailMb: z
      .number()
      .min(THRESHOLD_LIMITS.criticalAvailMb.min)
      .max(THRESHOLD_LIMITS.criticalAvailMb.max)
      .step(THRESHOLD_LIMITS.criticalAvailMb.step)
      .default(THRESHOLD_LIMITS.criticalAvailMb.default)
      .volatile()
      .description('Free commit headroom (MiB) below which "critical" also fires. Default 2048.'),
    confirmSamples: z
      .number()
      .min(THRESHOLD_LIMITS.confirmSamples.min)
      .max(THRESHOLD_LIMITS.confirmSamples.max)
      .step(THRESHOLD_LIMITS.confirmSamples.step)
      .default(THRESHOLD_LIMITS.confirmSamples.default)
      .volatile()
      .description('Consecutive samples required before any pressure state change. Default 3.'),
    cooldownMinutes: z
      .number()
      .min(THRESHOLD_LIMITS.cooldownMinutes.min)
      .max(THRESHOLD_LIMITS.cooldownMinutes.max)
      .step(THRESHOLD_LIMITS.cooldownMinutes.step)
      .default(THRESHOLD_LIMITS.cooldownMinutes.default)
      .volatile()
      .description('Minimum minutes between restart attempts. Default 30.'),
    restartGatePct: z
      .number()
      .min(THRESHOLD_LIMITS.restartGatePct.min)
      .max(THRESHOLD_LIMITS.restartGatePct.max)
      .step(THRESHOLD_LIMITS.restartGatePct.step)
      .default(THRESHOLD_LIMITS.restartGatePct.default)
      .volatile()
      .description(
        'Restart only if the DSH process tree holds at least this share of commit charge. Default 20. Set 0 to disable the gate; if attribution is unavailable the gate fails closed.',
      ),
    residentGrowMb: z
      .number()
      .min(THRESHOLD_LIMITS.residentGrowMb.min)
      .max(THRESHOLD_LIMITS.residentGrowMb.max)
      .step(THRESHOLD_LIMITS.residentGrowMb.step)
      .default(THRESHOLD_LIMITS.residentGrowMb.default)
      .volatile()
      .description(
        'How many MiB a single non-trivial process (>= 1 GiB) has to add within 5 minutes before this plugin names it in a warning. Default 512. Warning only: this plugin never stops another program\'s process.',
      ),
    autoRestart: z
      .boolean()
      .default(false)
      .volatile()
      .description(
        'Off by default. When enabled, restarts the ENTIRE DSH Desktop (the main process and all of its children), not just the UI.\n' +
          '• Restarting can discard unsent drafts.\n' +
          '• It triggers only when commit memory is critical, the configured number of consecutive samples confirm it, the restart gate passes, and the activity check reports idle.\n' +
          '• If the commit pressure comes from other software, restarting may not help.\n' +
          '• At most one restart per configured cooldown, and at most one attempt per critical episode.\n' +
          '• The Electron shell native quit confirmation is bypassed; profile and session data are still flushed by the Host graceful shutdown.',
      ),
    resumeAfterCrash: z
      .boolean()
      .default(false)
      .description(
        'Off by default. After DSH Desktop restarts, automatically continues sessions that were interrupted mid-turn (for example by a crash or after an automatic restart).\n' +
          '• Only turns marked "interrupted" are resumed; turns you canceled yourself are never resumed.\n' +
          '• Sessions idle for more than 20 seconds and interrupted within the last 12 hours are eligible.\n' +
          '• Each session is attempted at most twice per hour; every attempt is listed in the plugin card.\n' +
          '• Resumed turns run with the session\'s original tools and permissions.',
      ),
  })
  .description(
    'Windows commit-memory watchdog for DSH Desktop. Monitoring, attribution, crash history and warnings always run; automatic restart and crash-resume are opt-in.',
  )

export function apply(ctx, rawConfig, deps) {
  const runtime = new GuardRuntime({ ctx, rawConfig, deps })
  ctx.effect(
    () => {
      const unregister = registerRoutes(ctx, runtime)
      runtime
        .start()
        .catch((error) => {
          runtime.setError('start', error instanceof Error ? error.message : String(error))
          try {
            ctx.logger?.warn?.('dsh-commit-guard: runtime failed to start', error)
          } catch {}
        })
      const off = ctx.on?.('loader/volatile-update', (paths) => runtime.onConfigUpdate(paths))
      return async () => {
        if (typeof off === 'function') off()
        unregister()
        await runtime.dispose()
      }
    },
    'dsh-commit-guard: runtime',
  )
  return runtime
}
