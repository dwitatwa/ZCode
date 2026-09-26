/**
 * Info 屏：当前任务的运行信息。
 * 上下文 / 缓存 / 计划 / 后台任务 / 诊断来自快照轮询（App 3s）；
 * 子代理 / workflow run / 累计 token 用量在可见时按 5s 轮询专用 RPC。
 * taskId 即 agent sessionId（zcode-task-types-core），所以 v4 查询直接用 taskId。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import type {
  ZCodeSessionEndedSubagent,
  ZCodeSessionRunningSubagent,
  ZCodeTaskMeta,
  ZCodeTaskTokenUsageResult,
} from "@zcode/shared";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import { findConfigOption, formatTokens, thoughtLabel } from "../lib/catalog.js";
import type { MobileTaskSnapshot } from "../lib/types.js";

interface SubagentsState {
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
  endedTotal: number;
  error: string | null;
}

const EMPTY_SUBAGENTS: SubagentsState = { running: [], ended: [], endedTotal: 0, error: null };

function percent(used: number | undefined, size: number | undefined): number | null {
  if (!used || !size || size <= 0) return null;
  return Math.min(100, Math.round((used / size) * 100));
}

function shortStatus(status: string): string {
  return status;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="info-section">
      <div className="info-section-title">{title}</div>
      {children}
    </div>
  );
}

function Kv({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}

export function InfoScreen({
  service,
  agentService,
  meta,
  snapshot,
  visible,
}: {
  service: IZCodeTaskService;
  agentService: IZCodeAgentService | null;
  meta: ZCodeTaskMeta;
  snapshot: MobileTaskSnapshot | null;
  visible: boolean;
}) {
  const [usage, setUsage] = useState<ZCodeTaskTokenUsageResult | null>(null);
  const [subagents, setSubagents] = useState<SubagentsState>(EMPTY_SUBAGENTS);
  const [runs, setRuns] = useState<V4ConversationWorkflowRunSummary[] | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await service.getTaskTokenUsage({
          taskId: meta.taskId,
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
        });
        if (!cancelled) setUsage(result);
      } catch {
        // 用量库暂不可用时保持旧值
      }
      if (!agentService) return;
      try {
        const result = await agentService.listSessionSubagents({
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
          sessionId: meta.taskId,
          endedLimit: 6,
        });
        if (!cancelled) {
          setSubagents({
            running: result.running ?? [],
            ended: result.ended?.items ?? [],
            endedTotal: result.ended?.total ?? 0,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSubagents((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      try {
        const result = await agentService.conversationWorkflowRunsV4({
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
          sessionId: meta.taskId,
          limit: 8,
        });
        if (!cancelled) setRuns(result.runs);
      } catch {
        if (!cancelled) setRuns(null);
      }
    };

    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, service, agentService, meta]);

  const runtime = snapshot?.runtime;
  const contextUsage = runtime?.contextUsage;
  const cache = contextUsage?.cache;
  const contextPct = percent(contextUsage?.used, contextUsage?.size);
  const modelOption = findConfigOption(snapshot?.configOptions, "model");
  const thoughtOption = findConfigOption(snapshot?.configOptions, "thought_level");
  const plan = runtime?.plan ?? [];
  const jobs = runtime?.backgroundBashJobs ?? [];

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <span className="folder">ℹ️</span>
          <span className="title-text">{meta.title}</span>
        </div>
      </header>

      <div className="info-scroll">
        <Section title="Session">
          <Kv label="Model" value={modelOption ? String(modelOption.currentValue) : (meta.model ?? "—")} />
          <Kv
            label="Thinking"
            value={thoughtOption ? thoughtLabel(String(thoughtOption.currentValue)) : (meta.thoughtLevel ? thoughtLabel(meta.thoughtLevel) : "—")}
          />
          <Kv label="Mode" value={meta.mode ?? "—"} />
          <Kv label="Status" value={meta.status ?? "—"} />
          <Kv label="Created" value={new Date(meta.createdAt).toLocaleString()} />
        </Section>

        <Section title="Context">
          {contextPct === null ? (
            <div className="info-note">No live context yet — starts with the first turn.</div>
          ) : (
            <>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${contextPct}%` }} />
              </div>
              <Kv label="Used" value={`${formatTokens(contextUsage?.used)} / ${formatTokens(contextUsage?.size)} (${contextPct}%)`} />
              {contextUsage?.cost ? <Kv label="Cost" value={`$${contextUsage.cost.amount.toFixed(4)}`} /> : null}
            </>
          )}
        </Section>

        <Section title="Cache">
          {cache ? (
            <>
              <Kv label="Hit rate" value={cache.hitRate != null ? `${Math.round(cache.hitRate * 100)}%` : cache.latestHitRate != null ? `${Math.round(cache.latestHitRate * 100)}%` : "—"} />
              <Kv label="Cache read" value={formatTokens(cache.cacheReadTokens)} />
              <Kv label="Cache write" value={formatTokens(cache.cacheWriteTokens)} />
            </>
          ) : (
            <div className="info-note">No cache stats yet.</div>
          )}
        </Section>

        <Section title="Token usage (cumulative)">
          {usage ? (
            <>
              <Kv label="Total" value={formatTokens(usage.totalTokens)} />
              <Kv label="Input" value={formatTokens(usage.inputTokens)} />
              <Kv label="Output" value={formatTokens(usage.outputTokens)} />
              <Kv label="Reasoning" value={formatTokens(usage.reasoningTokens)} />
              <Kv label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
              <Kv label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
              <Kv label="Requests" value={`${usage.modelRequestCount} (${usage.modelErrorCount} failed)`} />
            </>
          ) : (
            <div className="info-note">Loading usage…</div>
          )}
        </Section>

        <Section title="Subagents">
          {subagents.running.length === 0 && subagents.ended.length === 0 ? (
            <div className="info-note">
              {subagents.error ? `Unavailable: ${subagents.error}` : "No subagent activity."}
            </div>
          ) : (
            <>
              {subagents.running.map((sub) => (
                <div key={sub.childSessionId} className="agent-row">
                  <span className={`agent-dot ${shortStatus(sub.status)}`} />
                  <div className="agent-main">
                    <div className="agent-title">{sub.title}</div>
                    <div className="agent-sub">
                      {sub.subagentType} · {sub.status}
                      {sub.startedAt ? ` · ${new Date(sub.startedAt).toLocaleTimeString()}` : ""}
                    </div>
                  </div>
                </div>
              ))}
              {subagents.ended.map((sub) => (
                <div key={sub.childSessionId} className="agent-row">
                  <span className={`agent-dot ${sub.status === "success" ? "success" : "failed"}`} />
                  <div className="agent-main">
                    <div className="agent-title">{sub.title}</div>
                    <div className="agent-sub">
                      {sub.subagentType} · {sub.status}
                    </div>
                  </div>
                </div>
              ))}
              {subagents.endedTotal > subagents.ended.length ? (
                <div className="info-note">+ {subagents.endedTotal - subagents.ended.length} earlier subagent(s)</div>
              ) : null}
            </>
          )}
        </Section>

        <Section title="Workflow runs">
          {runs === null ? (
            <div className="info-note">No workflow data.</div>
          ) : runs.length === 0 ? (
            <div className="info-note">No workflow runs in this task.</div>
          ) : (
            runs.map((run) => (
              <div key={run.runId} className="agent-row">
                <span className={`agent-dot ${run.status === "running" ? "running" : run.status === "completed" ? "success" : "failed"}`} />
                <div className="agent-main">
                  <div className="agent-title">{run.label ?? run.runId}</div>
                  <div className="agent-sub">
                    {run.status}
                    {run.stopReason ? ` · ${run.stopReason}` : ""}
                    {run.updatedAt ? ` · ${new Date(run.updatedAt).toLocaleTimeString()}` : ""}
                    {run.resumable ? " · resumable" : ""}
                  </div>
                </div>
              </div>
            ))
          )}
        </Section>

        {plan.length > 0 && (
          <Section title="Plan">
            {plan.map((step) => (
              <div key={step.id} className="plan-row">
                <span className="plan-mark">{step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"}</span>
                <span className="plan-title">{step.title}</span>
              </div>
            ))}
          </Section>
        )}

        {jobs.length > 0 && (
          <Section title="Background jobs">
            {jobs.map((job) => (
              <div key={job.jobId} className="agent-row">
                <span className={`agent-dot ${job.status === "running" ? "running" : job.status === "completed" ? "success" : "failed"}`} />
                <div className="agent-main">
                  <div className="agent-title">{job.title ?? job.command}</div>
                  <div className="agent-sub">{job.taskKind} · {job.status}</div>
                  {(job.outputTail ?? job.stdoutTail) ? (
                    <pre className="job-tail">{(job.outputTail ?? job.stdoutTail ?? "").slice(-400)}</pre>
                  ) : null}
                </div>
              </div>
            ))}
          </Section>
        )}

        <Section title="Diagnostics">
          {runtime?.apiRetry ? (
            <Kv label="API retry" value={`attempt ${runtime.apiRetry.attempt}/${runtime.apiRetry.maxRetries}${runtime.apiRetry.errorStatus ? ` (${runtime.apiRetry.errorStatus})` : ""}`} />
          ) : null}
          {meta.lastError ? <Kv label="Last error" value={meta.lastError.message} /> : null}
          {meta.changeSummary ? (
            <Kv
              label="Changes"
              value={`${meta.changeSummary.fileCount} file(s), +${meta.changeSummary.added} −${meta.changeSummary.removed}`}
            />
          ) : null}
          {runtime?.goalStats ? (
            <Kv
              label="Activity"
              value={`${runtime.goalStats.toolCallCount} tool calls · ${runtime.goalStats.iterationCount} iterations`}
            />
          ) : null}
          {!runtime?.apiRetry && !meta.lastError && !meta.changeSummary && !runtime?.goalStats && (
            <div className="info-note">Nothing notable.</div>
          )}
        </Section>

        <div className="sheet-tail-space" />
      </div>
    </>
  );
}
