/**
 * Info 屏：当前任务的运行信息。
 * antd-mobile NavBar/ProgressCircle/List/Tag/SpinLoading + lucide 图标。
 * 上下文 / 缓存 / 计划 / 后台任务 / 诊断来自快照轮询（App 3s）；
 * 子代理 / workflow run / 累计 token 用量在可见时按 5s 轮询专用 RPC。
 * taskId 即 agent sessionId（zcode-task-types-core），所以 v4 查询直接用 taskId。
 */
import { useEffect, useState, type ReactNode } from "react";
import { List, NavBar, ProgressCircle, SpinLoading, Tag } from "antd-mobile";
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
    <List.Item extra={<span className="kv-value">{value}</span>}>{label}</List.Item>
  );
}

const STATUS_TAG_COLOR: Record<string, string> = {
  running: "primary",
  waiting: "primary",
  success: "success",
  completed: "success",
  failed: "danger",
  errored: "danger",
  blocked: "danger",
  cancelled: "warning",
  lost: "warning",
  stopped: "warning",
  pending: "default",
};

function StatusTag({ status }: { status: string }) {
  return (
    <Tag color={STATUS_TAG_COLOR[status] ?? "default"} fill="outline" style={{ fontSize: 10 }}>
      {status}
    </Tag>
  );
}

function AgentRow({
  dotStatus,
  tagStatus,
  title,
  sub,
  tail,
}: {
  dotStatus: string;
  tagStatus: string;
  title: string;
  sub: string;
  tail?: string;
}) {
  return (
    <div className="agent-row">
      <span className={`agent-dot ${dotStatus}`} />
      <div className="agent-main">
        <div className="agent-title">{title}</div>
        <div className="agent-sub">
          {sub} <StatusTag status={tagStatus} />
        </div>
        {tail ? <pre className="job-tail">{tail}</pre> : null}
      </div>
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
      <NavBar back={null} style={{ ["--background-color" as string]: "var(--surface)" }}>
        <span className="title-text">Task info</span>
      </NavBar>

      <div className="info-scroll">
        <Section title="Session">
          <List>
            <Kv
              label="Model"
              value={modelOption ? String(modelOption.currentValue) : (meta.model ?? "—")}
            />
            <Kv
              label="Thinking"
              value={
                thoughtOption
                  ? thoughtLabel(String(thoughtOption.currentValue))
                  : meta.thoughtLevel
                    ? thoughtLabel(meta.thoughtLevel)
                    : "—"
              }
            />
            <Kv label="Mode" value={meta.mode ?? "—"} />
            <Kv label="Status" value={meta.status ? <StatusTag status={meta.status} /> : "—"} />
            <Kv label="Created" value={new Date(meta.createdAt).toLocaleString()} />
          </List>
        </Section>

        <Section title="Context">
          {contextPct === null ? (
            <div className="info-note">No live context yet — starts with the first turn.</div>
          ) : (
            <div className="context-row">
              <ProgressCircle percent={contextPct} style={{ "--size": "72px", "--track-width": "6px", "--track-color": "var(--surface-2)", "--fill-color": "var(--accent)", fontSize: 14 }}>
                {contextPct}%
              </ProgressCircle>
              <div className="context-meta">
                <div>
                  <b>{formatTokens(contextUsage?.used)}</b> / {formatTokens(contextUsage?.size)}
                </div>
                {contextUsage?.cost ? <div>${contextUsage.cost.amount.toFixed(4)}</div> : null}
              </div>
            </div>
          )}
        </Section>

        <Section title="Cache">
          {cache ? (
            <List>
              <Kv
                label="Hit rate"
                value={
                  cache.hitRate != null
                    ? `${Math.round(cache.hitRate * 100)}%`
                    : cache.latestHitRate != null
                      ? `${Math.round(cache.latestHitRate * 100)}%`
                      : "—"
                }
              />
              <Kv label="Cache read" value={formatTokens(cache.cacheReadTokens)} />
              <Kv label="Cache write" value={formatTokens(cache.cacheWriteTokens)} />
            </List>
          ) : (
            <div className="info-note">No cache stats yet.</div>
          )}
        </Section>

        <Section title="Token usage (cumulative)">
          {usage ? (
            <List>
              <Kv label="Total" value={formatTokens(usage.totalTokens)} />
              <Kv label="Input" value={formatTokens(usage.inputTokens)} />
              <Kv label="Output" value={formatTokens(usage.outputTokens)} />
              <Kv label="Reasoning" value={formatTokens(usage.reasoningTokens)} />
              <Kv label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
              <Kv label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
              <Kv label="Requests" value={`${usage.modelRequestCount} (${usage.modelErrorCount} failed)`} />
            </List>
          ) : (
            <SpinLoading color="primary" style={{ "--size": "18px" }} />
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
                <AgentRow
                  key={sub.childSessionId}
                  dotStatus={sub.status}
                  tagStatus={sub.status}
                  title={sub.title}
                  sub={`${sub.subagentType}${sub.startedAt ? ` · ${new Date(sub.startedAt).toLocaleTimeString()}` : ""}`}
                />
              ))}
              {subagents.ended.map((sub) => (
                <AgentRow
                  key={sub.childSessionId}
                  dotStatus={sub.status}
                  tagStatus={sub.status}
                  title={sub.title}
                  sub={sub.subagentType}
                />
              ))}
              {subagents.endedTotal > subagents.ended.length ? (
                <div className="info-note">
                  + {subagents.endedTotal - subagents.ended.length} earlier subagent(s)
                </div>
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
              <AgentRow
                key={run.runId}
                dotStatus={run.status}
                tagStatus={run.status}
                title={run.label ?? run.runId}
                sub={`${run.stopReason ? `${run.stopReason} · ` : ""}${
                  run.updatedAt ? `${new Date(run.updatedAt).toLocaleTimeString()} · ` : ""
                }${run.resumable ? "resumable" : "final"}`}
              />
            ))
          )}
        </Section>

        {plan.length > 0 && (
          <Section title="Plan">
            {plan.map((step) => (
              <div key={step.id} className="plan-row">
                <span className="plan-mark">
                  {step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"}
                </span>
                <span className="plan-title">{step.title}</span>
              </div>
            ))}
          </Section>
        )}

        {jobs.length > 0 && (
          <Section title="Background jobs">
            {jobs.map((job) => (
              <AgentRow
                key={job.jobId}
                dotStatus={job.status}
                tagStatus={job.status}
                title={job.title ?? job.command}
                sub={job.taskKind}
                tail={job.outputTail ?? job.stdoutTail ? (job.outputTail ?? job.stdoutTail ?? "").slice(-400) : undefined}
              />
            ))}
          </Section>
        )}

        <Section title="Diagnostics">
          {runtime?.apiRetry ? (
            <List>
              <Kv
                label="API retry"
                value={`attempt ${runtime.apiRetry.attempt}/${runtime.apiRetry.maxRetries}${
                  runtime.apiRetry.errorStatus ? ` (${runtime.apiRetry.errorStatus})` : ""
                }`}
              />
            </List>
          ) : null}
          {meta.lastError ? (
            <List>
              <Kv label="Last error" value={meta.lastError.message} />
            </List>
          ) : null}
          {meta.changeSummary ? (
            <List>
              <Kv
                label="Changes"
                value={`${meta.changeSummary.fileCount} file(s), +${meta.changeSummary.added} −${meta.changeSummary.removed}`}
              />
            </List>
          ) : null}
          {runtime?.goalStats ? (
            <List>
              <Kv
                label="Activity"
                value={`${runtime.goalStats.toolCallCount} tool calls · ${runtime.goalStats.iterationCount} iterations`}
              />
            </List>
          ) : null}
          {!runtime?.apiRetry && !meta.lastError && !meta.changeSummary && !runtime?.goalStats && (
            <div className="info-note">Nothing notable.</div>
          )}
        </Section>
      </div>
    </>
  );
}
