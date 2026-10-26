function busy(reason, detail = {}) {
  return { idle: false, reason, ...detail }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function inspectActivity(ctx, { now = Date.now } = {}) {
  const checkedAt = now()
  try {
    const agentsService = ctx?.get?.('agents')
    const jobsService = ctx?.get?.('jobs')
    if (agentsService === undefined || agentsService === null || typeof agentsService.list !== 'function') {
      return busy('agents-unavailable', { checkedAt })
    }
    if (jobsService === undefined || jobsService === null || typeof jobsService.list !== 'function') {
      return busy('jobs-unavailable', { checkedAt })
    }
    const agents = await agentsService.list()
    if (!Array.isArray(agents)) return busy('agents-malformed', { checkedAt })
    for (const agent of agents) {
      if (!isRecord(agent)) return busy('agents-malformed', { checkedAt })
      if (typeof agent.id !== 'string' || agent.id.length === 0) return busy('agents-malformed', { checkedAt })
      if (typeof agent.status !== 'string') return busy('agent-status-unreadable', { checkedAt })
      if (agent.status === 'running') return busy('agent-running', { checkedAt })
      const inbox = agent.inbox
      if (!isRecord(inbox) || !Array.isArray(inbox.nextTurn) || !Array.isArray(inbox.nextStep)) {
        return busy('agent-queue-unreadable', { checkedAt })
      }
      if (inbox.nextTurn.length > 0 || inbox.nextStep.length > 0) return busy('agent-queued', { checkedAt })
    }
    const scopes = [undefined, ...agents.map((agent) => agent.id)]
    for (const scope of scopes) {
      const jobs = await jobsService.list(scope)
      if (!Array.isArray(jobs)) return busy('jobs-malformed', { checkedAt })
      for (const job of jobs) {
        if (!isRecord(job) || typeof job.status !== 'string') return busy('job-status-unreadable', { checkedAt })
        if (job.status === 'running' || job.status === 'stopping') return busy('job-active', { checkedAt })
      }
    }
    return { idle: true, reason: null, checkedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return busy(`activity-error: ${message}`, { checkedAt })
  }
}
