export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

export function readAutoRestart(rawConfig) {
  return unwrapVolatile(rawConfig?.autoRestart) === true
}

export function readResumeAfterCrash(rawConfig) {
  return unwrapVolatile(rawConfig?.resumeAfterCrash) === true
}

export function configSnapshot(rawConfig, thresholds = null) {
  return {
    autoRestart: readAutoRestart(rawConfig),
    resumeAfterCrash: readResumeAfterCrash(rawConfig),
    thresholds,
  }
}
