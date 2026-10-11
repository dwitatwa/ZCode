/**
 * Info 屏：当前任务的运行信息（会话配置 / 上下文 / 缓存 / 用量 / 子代理 / workflow / 诊断）。
 *
 * 与旧版的差别只在呈现：去掉 antd-mobile 的 List/ProgressCircle/Tag，
 * 改成等宽键值表 + 自绘进度条 + 文字状态。数据源与轮询节奏保持不变：
 * 上下文/计划/后台任务来自 App 的快照（3s），
 * 用量/子代理/workflow 在可见时按 5s 走专用 RPC。
 */
import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import type {
  ZCodeSessionEndedSubagent,
  ZCodeSessionRunningSubagent,
  ZCodeTaskTokenUsageResult,
} from "@zcode/shared";
import type {
  ConversationSnapshot,
  V4ConversationWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { formatTokens, thoughtLabel } from "../lib/catalog.js";

const INFO_POLL_MS = 5000;

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
    <section className="info-section">
      <h2 className="info-section-title">{title}</h2>
      {children}
    </section>
  );
}

function Kv({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv-key">{label}</span>
      <span className="kv-val">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "running" || status === "waiting"
      ? "live"
      : status === "failed" || status === "errored" || status === "blocked"
        ? "bad"
        : "idle";
  return <span className={`pill pill-${tone}`}>{status}</span>;
}

function AgentRow({
  status,
  title,
  sub,
  tail,
}: {
  status: string;
  title: string;
  sub: string;
  tail?: string;
}) {
  return (
    <div className="agent-row">
      <span className={`agent-dot ${status}`} />
      <div className="agent-main">
        <div className="agent-title">{title}</div>
        <div className="agent-sub">
          {sub} <StatusPill status={status} />
        </div>
        {tail ? <pre className="job-tail">{tail}</pre> : null}
      </div>
    </div>
  );
}

export function InfoScreen({
  service,
  agentService,
  taskId,
  workspacePath,
  workspaceIdentity,
  snapshot,
  visible,
}: {
  service: IZCodeTaskService;
  agentService: IZCodeAgentService | null;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  snapshot: ConversationSnapshot | null;
  visible: boolean;
}) {
  const [usage, setUsage] = useState<ZCodeTaskTokenUsageResult | null>(null);
  const [subagents, setSubagents] = useState<SubagentsState>(EMPTY_SUBAGENTS);
  const [runs, setRuns] = useState<V4ConversationWorkflowRunSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      setRefreshing(true);
      try {
        const result = await service.getTaskTokenUsage({
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        if (!cancelled) setUsage(result);
      } catch {
        // 用量库暂不可用时保留旧值
      }
      if (agentService) {
        try {
          const result = await agentService.listSessionSubagents({
            workspacePath,
            workspaceIdentity,
            sessionId: taskId,
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
            workspacePath,
            workspaceIdentity,
            sessionId: taskId,
            limit: 8,
          });
          if (!cancelled) setRuns(result.runs);
        } catch {
          if (!cancelled) setRuns(null);
        }
      }
      if (!cancelled) setRefreshing(false);
    };

    void poll();
    const timer = setInterval(poll, INFO_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, service, agentService, taskId, workspacePath, workspaceIdentity]);

  // 运行信息改读 v4 投影快照（与聊天屏同一份事实），不再是 legacy task snapshot。
  const config = snapshot?.config;
  const contextUsage = snapshot?.usage.contextWindow
    ? {
        used: snapshot.usage.contextWindow.usedTokens,
        size: snapshot.usage.contextWindow.maxTokens,
        cost: null as { amount: number; currency: string } | null,
      }
    : undefined;
  const contextPct = percent(contextUsage?.used, contextUsage?.size);
  const cacheUsage = snapshot?.usage.contextWindow?.cache;
  const plan = snapshot?.plan?.items ?? [];
  const jobs = snapshot?.backgroundWorks ?? [];

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">Task info</div>
        {refreshing ? <RefreshCw size={13} className="topbar-spin" /> : null}
      </header>

      <div className="info-scroll">
        <Section title="Context">
          {contextPct === null ? (
            <div className="note">No live context yet — starts with the first turn.</div>
          ) : (
            <>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${contextPct}%` }} />
              </div>
              <div className="meter-legend">
                <span>
                  <b>{formatTokens(contextUsage?.used)}</b> / {formatTokens(contextUsage?.size)} ·{" "}
                  {contextPct}%
                </span>
                {contextUsage?.cost ? <span>${contextUsage.cost.amount.toFixed(4)}</span> : null}
              </div>
            </>
          )}
        </Section>

        <Section title="Session">
          <Kv label="Model" value={config ? config.model : "—"} />
          <Kv label="Thinking" value={config ? thoughtLabel(config.thought) : "—"} />
          <Kv label="Mode" value={config?.mode ?? "—"} />
        </Section>

        <Section title="Token usage">
          {usage ? (
            <>
              <Kv label="Total" value={formatTokens(usage.totalTokens)} />
              <Kv label="Input" value={formatTokens(usage.inputTokens)} />
              <Kv label="Output" value={formatTokens(usage.outputTokens)} />
              <Kv label="Reasoning" value={formatTokens(usage.reasoningTokens)} />
              <Kv label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
              <Kv label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
              <Kv
                label="Requests"
                value={`${usage.modelRequestCount} (${usage.modelErrorCount} failed)`}
              />
            </>
          ) : (
            <div className="note">Loading…</div>
          )}
        </Section>

        {cacheUsage ? (
          <Section title="Cache">
            <Kv
              label="Hit rate"
              value={
                cacheUsage.hitRate != null
                  ? `${Math.round(cacheUsage.hitRate * 100)}%`
                  : "—"
              }
            />
            <Kv label="Cache read" value={formatTokens(cacheUsage.cacheReadTokens)} />
            <Kv label="Cache write" value={formatTokens(cacheUsage.cacheWriteTokens)} />
          </Section>
        ) : null}

        <Section title="Subagents">
          {subagents.running.length === 0 && subagents.ended.length === 0 ? (
            <div className="note">
              {subagents.error ? `Unavailable: ${subagents.error}` : "No subagent activity."}
            </div>
          ) : (
            <>
              {subagents.running.map((sub) => (
                <AgentRow
                  key={sub.childSessionId}
                  status={sub.status}
                  title={sub.title}
                  sub={sub.subagentType}
                />
              ))}
              {subagents.ended.map((sub) => (
                <AgentRow
                  key={sub.childSessionId}
                  status={sub.status}
                  title={sub.title}
                  sub={sub.subagentType}
                />
              ))}
              {subagents.endedTotal > subagents.ended.length ? (
                <div className="note">
                  +{subagents.endedTotal - subagents.ended.length} earlier subagent(s)
                </div>
              ) : null}
            </>
          )}
        </Section>

        {runs && runs.length > 0 ? (
          <Section title="Workflow runs">
            {runs.map((run) => (
              <AgentRow
                key={run.runId}
                status={run.status}
                title={run.label ?? run.runId}
                sub={`${run.stopReason ? `${run.stopReason} · ` : ""}${
                  run.resumable ? "resumable" : "final"
                }`}
              />
            ))}
          </Section>
        ) : null}

        {plan.length > 0 ? (
          <Section title="Plan">
            {plan.map((step) => (
              <div key={step.id} className="plan-row">
                <span className="plan-mark">
                  {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
                </span>
                <span className="plan-title">{step.content}</span>
              </div>
            ))}
          </Section>
        ) : null}

        {jobs.length > 0 ? (
          <Section title="Background jobs">
            {jobs.map((job) => (
              <AgentRow
                key={job.workId}
                status={job.status}
                title={job.title}
                sub={job.kind}
              />
            ))}
          </Section>
        ) : null}

        <Section title="Diagnostics">
          {snapshot?.usage.contextWindow?.autoCompactThresholdTokens != null ? (
            <Kv
              label="Auto compact at"
              value={formatTokens(snapshot.usage.contextWindow.autoCompactThresholdTokens)}
            />
          ) : null}
          {snapshot ? (
            <Kv label="Rows total" value={String(snapshot.rows.totalCount)} />
          ) : null}
          {snapshot ? <Kv label="Log epoch" value={snapshot.logEpoch} /> : null}
          {snapshot ? <Kv label="Revision" value={String(snapshot.revision)} /> : null}
          {!snapshot ? <div className="note">Nothing notable.</div> : null}
        </Section>
      </div>
    </>
  );
}
