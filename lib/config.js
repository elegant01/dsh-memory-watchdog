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

export function readPluginConfig(rawConfig) {
  const number = (value, fallback) => {
    const unwrapped = unwrapVolatile(value)
    return typeof unwrapped === 'number' && Number.isFinite(unwrapped) ? unwrapped : fallback
  }
  return {
    pluginMemory: unwrapVolatile(rawConfig?.pluginMemory) !== false,
    pluginSampling: unwrapVolatile(rawConfig?.pluginSampling) !== false,
    pluginSampleMinutes: number(rawConfig?.pluginSampleMinutes, 15),
    pluginSampleSeconds: number(rawConfig?.pluginSampleSeconds, 20),
    pluginLeakMb: number(rawConfig?.pluginLeakMb, 32),
  }
}

export function configSnapshot(rawConfig, thresholds = null) {
  return {
    autoRestart: readAutoRestart(rawConfig),
    resumeAfterCrash: readResumeAfterCrash(rawConfig),
    thresholds,
  }
}
