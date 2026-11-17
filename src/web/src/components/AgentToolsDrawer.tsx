import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { meQuery } from '../lib/queries';
import { Drawer } from './ui/Drawer';
import { Segmented } from './ui/Segmented';
import {
  AGENT_TOOLS_ENGINES,
  AGENT_TOOLS_GUIDE,
  agentToolsFamilyRows,
  agentToolsLayers,
  agentToolsMode,
  agentToolsSections,
  agentToolsStatus,
  agentToolsWithheldReasons,
  defaultCarrier,
  engineName,
  type AgentToolsEngine,
  type AgentToolsLayer,
  type AgentToolsReport,
} from '../lib/agentTools';
import { ago } from '../lib/runnerEngines';
import './AgentToolsDrawer.css';

/**
 * Agent tools (docs/mocks/agent-tools/01-board.png, approved 2026-11-14): what an agent in Orbit can reach and what
 * it was told. Read-only — no switch or form lives here; the switches stay where they are and the drawer says where.
 *
 * On a session it shows that session's real connection, from the report its runner sent (lib/agentTools): whether
 * the engine started Orbit's MCP server and, if not, in the engine's own words why; the tools it lists by family and
 * why one is short; what its permission mode means for Orbit's calls; and the instructions it reads, in order, with
 * their role. On a workspace it shows what a session there is given, per engine. Both end with "How agents use
 * Orbit", the guide generated from the operation catalogue.
 */
export type AgentToolsDrawerProps =
  | {
      mode: 'session';
      open: boolean;
      onClose: () => void;
      report: AgentToolsReport | null | undefined;
      /** The session's engine, for a session whose runner sent no report. */
      engine: string | null | undefined;
      /** The session's permission mode as the server stores it. */
      permissionMode: string | null | undefined;
      now?: number;
    }
  | {
      mode: 'workspace';
      open: boolean;
      onClose: () => void;
      workspaceName: string;
      /** The workspace's runtime instructions (appendSystemPrompt), and whether it replaces the engine's prompt. */
      instructions: string;
      baseInstructions: boolean;
      onEditInstructions?: () => void;
    };

/** The account's Session orchestration switch as it is now (absent means on, as Settings reads it). */
function useOrchestrationOn(): boolean {
  const me = useQuery(meQuery());
  return me.data?.preferences?.enableOrchestration ?? true;
}

export function AgentToolsDrawer(props: AgentToolsDrawerProps) {
  const title = props.mode === 'workspace' ? `Agent tools · ${props.workspaceName}` : 'Agent tools';
  return (
    <Drawer open={props.open} onClose={props.onClose} title={title} width={560} className="agent-tools-drawer">
      {props.mode === 'session' ? <SessionAgentTools {...props} /> : <WorkspaceAgentTools {...props} />}
    </Drawer>
  );
}

function SessionAgentTools({
  report,
  engine,
  permissionMode,
  now = Date.now(),
}: Extract<AgentToolsDrawerProps, { mode: 'session' }>) {
  const orchestrationOn = useOrchestrationOn();
  const status = agentToolsStatus(report, engine);
  const shownEngine = report?.engine ?? engine ?? '';
  const mode = agentToolsMode(permissionMode ?? report?.permissionMode);
  const modeLabel = mode?.label ?? permissionMode ?? report?.permissionMode ?? '';
  return (
    <div className="agent-tools">
      <p className="agent-tools-sub">What the agent in this session can reach in Orbit, and what it was told.</p>

      <section className={`agent-tools-status is-${status.tone}`} aria-label="Orbit connection">
        <div className="agent-tools-status-top">
          <span className="agent-tools-dot" aria-hidden />
          <span className="agent-tools-status-word">{status.word}</span>
          {report?.at && <span className="agent-tools-status-when">Reported {ago(report.at, now)}</span>}
        </div>
        <div className="agent-tools-status-line">{status.line}</div>
        {(status.detail || status.fallback) && (
          <div className="agent-tools-status-why">
            {status.detail && <code className="agent-tools-quote">{status.detail}</code>}
            {status.fallback}
          </div>
        )}
        {report && (
          <div className="agent-tools-versions">
            Agent Contract {report.versions.contract} · Operation catalogue {report.versions.catalog} · Primer{' '}
            {report.versions.primer} · Guide {report.versions.guide}
          </div>
        )}
      </section>

      <section className="agent-tools-sec">
        <h3 className="agent-tools-sec-title">
          Tools in this session <small>by what they act on</small>
        </h3>
        <div className="agent-tools-card">
          {report ? (
            <>
              <div className="agent-tools-families">
                {agentToolsFamilyRows(report).map((row) => (
                  <div key={row.id} className={`agent-tools-family is-${row.tone}`}>
                    <span className="agent-tools-dot" aria-hidden />
                    <span className="agent-tools-family-label">{row.label}</span>
                    <span className="agent-tools-family-count">
                      {row.reason && row.served === 0 && row.reason !== 'not_connected'
                        ? 'off'
                        : row.served < row.total
                          ? `${row.served} of ${row.total}`
                          : row.total}
                    </span>
                  </div>
                ))}
              </div>
              <div className="agent-tools-why">
                {(() => {
                  const reasons = agentToolsWithheldReasons(report);
                  if (reasons.length > 0) return reasons.map((r) => <p key={r}>{r}</p>);
                  return <p>{orchestrationOn ? AGENT_TOOLS_GUIDE.orchestration.on : AGENT_TOOLS_GUIDE.orchestration.off}</p>;
                })()}
                {report.switches.orchestration !== orchestrationOn && (
                  <p>
                    {orchestrationOn
                      ? 'Session orchestration was turned on after this engine started: its session, agent and runner tools arrive when the engine next starts.'
                      : 'Session orchestration was turned off after this engine started: the tools may still be listed, and Orbit refuses every call to them.'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="agent-tools-why">
              <p>Shown once this session's engine reports the tools it has.</p>
              <p>{orchestrationOn ? AGENT_TOOLS_GUIDE.orchestration.on : AGENT_TOOLS_GUIDE.orchestration.off}</p>
            </div>
          )}
        </div>
      </section>

      {mode && (
        <section className="agent-tools-sec">
          <h3 className="agent-tools-sec-title">
            Permission mode <small>{modeLabel}</small>
          </h3>
          <div className="agent-tools-card">
            <p className="agent-tools-plain">{mode.orbit}</p>
          </div>
        </section>
      )}

      <Instructions
        engine={shownEngine}
        facts={{
          base: report?.instructions.base ?? false,
          workspace: report?.instructions.workspace ?? false,
          carrier: report?.instructions.carrier ?? defaultCarrier(shownEngine),
        }}
        workspaceChars={report?.instructions.workspaceChars}
        skill={report?.skill}
      />

      <HowAgentsUseOrbit examplesOpen={false} />
    </div>
  );
}

function WorkspaceAgentTools({
  instructions,
  baseInstructions,
  onEditInstructions,
}: Extract<AgentToolsDrawerProps, { mode: 'workspace' }>) {
  const orchestrationOn = useOrchestrationOn();
  const [engine, setEngine] = useState<AgentToolsEngine>('claude');
  const chars = Array.from(instructions.trim()).length;
  return (
    <div className="agent-tools">
      <p className="agent-tools-sub">
        What a session in this workspace is given. Its live connection is on the session: More actions → Agent tools.
      </p>
      <section className="agent-tools-sec">
        <h3 className="agent-tools-sec-title">
          Instructions <small>in the order the engine reads them</small>
        </h3>
        <Segmented
          aria-label="Engine"
          size="small"
          className="agent-tools-engine"
          value={engine}
          onValueChange={setEngine}
          options={AGENT_TOOLS_ENGINES.map((e) => ({ value: e, label: engineName(e) }))}
        />
        <InstructionList
          engine={engine}
          layers={agentToolsLayers(engine, { base: baseInstructions, workspace: chars > 0, carrier: defaultCarrier(engine) })}
          workspaceChars={chars}
          onEditInstructions={onEditInstructions}
        />
        <p className="agent-tools-foot">{AGENT_TOOLS_GUIDE.instructionsNote}</p>
      </section>
      <section className="agent-tools-sec">
        <h3 className="agent-tools-sec-title">Session orchestration</h3>
        <div className="agent-tools-card">
          <p className="agent-tools-plain">{orchestrationOn ? AGENT_TOOLS_GUIDE.orchestration.on : AGENT_TOOLS_GUIDE.orchestration.off}</p>
        </div>
      </section>
      <HowAgentsUseOrbit examplesOpen />
    </div>
  );
}

function Instructions({
  engine,
  facts,
  workspaceChars,
  skill,
}: {
  engine: string;
  facts: { base: boolean; workspace: boolean; carrier: string };
  workspaceChars?: number;
  skill?: AgentToolsReport['skill'];
}) {
  const measured = (AGENT_TOOLS_ENGINES as readonly string[]).includes(engine);
  return (
    <section className="agent-tools-sec">
      <h3 className="agent-tools-sec-title">
        Instructions <small>{measured ? `in the order ${engineName(engine)} reads them` : 'what the agent reads'}</small>
      </h3>
      {measured ? (
        <InstructionList engine={engine} layers={agentToolsLayers(engine, facts)} workspaceChars={workspaceChars} skill={skill} />
      ) : (
        <div className="agent-tools-card">
          <p className="agent-tools-plain">
            {engineName(engine)} reads Orbit's runtime instructions, which begin with the primer, in the place its runner gives
            them; the order is laid out here for Claude Code and Codex, where it was measured.
          </p>
        </div>
      )}
      {measured && <p className="agent-tools-foot">{AGENT_TOOLS_GUIDE.instructionsNote}</p>}
    </section>
  );
}

function InstructionList({
  engine,
  layers,
  workspaceChars,
  skill,
  onEditInstructions,
}: {
  engine: string;
  layers: AgentToolsLayer[];
  workspaceChars?: number;
  skill?: AgentToolsReport['skill'];
  onEditInstructions?: () => void;
}) {
  return (
    <ol className="agent-tools-card agent-tools-layers" aria-label={`Instructions ${engineName(engine)} reads`}>
      {layers.map((layer, i) => (
        <li key={`${layer.id}-${i}`} className="agent-tools-layer">
          <span className="agent-tools-num">{i + 1}</span>
          <div className="agent-tools-layer-text">
            <div className="agent-tools-layer-title">
              {layer.title} <span className={`agent-tools-role is-${layer.role}`}>{layer.roleLabel}</span>
            </div>
            <div className="agent-tools-layer-detail">
              {layer.id === 'skill' && skill && skillWord(skill)}
              {layer.detail}
              {layer.id === 'workspace' && workspaceChars ? ` ${workspaceChars} characters.` : null}
              {layer.id === 'workspace' && onEditInstructions ? (
                <>
                  {' '}
                  <button type="button" className="agent-tools-link" onClick={onEditInstructions}>
                    Edit
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** What became of the playbooks on this session, ahead of what they are. */
function skillWord(skill: AgentToolsReport['skill']): string {
  if (!skill.offered) return skill.reason ? `Not offered: ${skill.reason} ` : 'Not offered. ';
  if (skill.loaded === true) return 'Loaded. ';
  if (skill.loaded === false) return 'Offered, but the engine did not list it. ';
  return 'Offered. ';
}

function HowAgentsUseOrbit({ examplesOpen }: { examplesOpen: boolean }) {
  const guide = AGENT_TOOLS_GUIDE;
  return (
    <>
      {examplesOpen && (
        <section className="agent-tools-sec">
          <h3 className="agent-tools-sec-title">
            Try asking <small>what the agent does, and what proves it</small>
          </h3>
          <Examples />
        </section>
      )}
      <section className="agent-tools-sec">
        <h3 className="agent-tools-sec-title">
          How agents use Orbit <small>generated from the operation catalogue</small>
        </h3>
        <div className="agent-tools-card">
          {agentToolsSections().map((section) => (
            <details key={section.id} className="agent-tools-fold">
              <summary>
                {section.title}
                {section.id === 'troubleshooting' && <span className="agent-tools-fold-hint">{guide.troubleshooting.length} symptoms</span>}
              </summary>
              <div className="agent-tools-fold-body">
                <p>{section.lead}</p>
                <ul>
                  {section.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
                {section.id === 'troubleshooting' && (
                  <dl className="agent-tools-troubles">
                    {guide.troubleshooting.map((t) => (
                      <div key={t.id} className="agent-tools-trouble">
                        <dt>
                          {t.symptom}
                          {t.code && <code>{t.code}</code>}
                        </dt>
                        <dd>
                          {t.cause} {t.fix}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {section.asks && section.asks.length > 0 && (
                  <p className="agent-tools-asks">Try asking: {section.asks.map((a) => `“${a}”`).join(' · ')}</p>
                )}
              </div>
            </details>
          ))}
          {!examplesOpen && (
            <details className="agent-tools-fold">
              <summary>
                Try asking<span className="agent-tools-fold-hint">{guide.examples.length} examples</span>
              </summary>
              <div className="agent-tools-fold-body">
                <Examples />
              </div>
            </details>
          )}
        </div>
      </section>
    </>
  );
}

function Examples() {
  return (
    <div className="agent-tools-card agent-tools-examples">
      {AGENT_TOOLS_GUIDE.examples.map((ex) => (
        <div key={ex.id} className="agent-tools-example">
          <div className="agent-tools-ask">“{ex.ask}”</div>
          <div className="agent-tools-does">{ex.does}</div>
          <div className="agent-tools-proof">Proof: {ex.proof}</div>
        </div>
      ))}
    </div>
  );
}

/** The session menu's line for the drawer: the word and tone the drawer opens with. */
export function agentToolsMenuStatus(report: AgentToolsReport | null | undefined, engine: string | null | undefined) {
  const status = agentToolsStatus(report, engine);
  return { word: status.word, tone: status.tone };
}
