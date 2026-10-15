Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started; returns on the first result, a new error line in a running bash job's output, {{stallMinutes}} min of silence after steady output, or a steering interrupt. Silence from a job that printed nothing does not wake it. After {{limitMinutes}} min it returns `## Wait limit reached` with each job's runtime; call it again to keep waiting.
Nothing you started running? Errors.
Results auto-deliver. NEVER poll while work remains.
