import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useLayoutEffect, useRef, useState } from 'react';
import type { SlashCommandInfo } from '@orbit/shared';
import { api } from '../api';
import { agentsQuery } from '../lib/queries';
import type { Runner } from '../components/TasksSidePanel';

// One catalog row: the skill/command name plus its (often long) routing description.
// The description is the SKILL.md frontmatter written for the model, so it can run several
// lines; we clamp it to two and let the user expand only the ones that are actually cut off.
function SkillRow({ item }: { item: SlashCommandInfo }) {
  const descRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    // Measured while collapsed (clamped) — only offer "expand" when text is truncated.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [item.description]);

  return (
    <div className="skill-item">
      <span className="skill-name">/{item.name}</span>
      {item.description && (
        <span className="skill-desc-wrap">
          <span ref={descRef} className={`skill-desc${expanded ? ' expanded' : ''}`}>
            {item.description}
          </span>
          {(overflowing || expanded) && (
            <button
              type="button"
              className="skill-desc-toggle"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// One collapsible scope group: an agent's project assets, or a runner's host-level
// "Shared" bucket. Skills come from a runner's filesystem (.claude/skills/commands),
// tagged by the agent whose workDir they were found in (empty = host, shared by all
// agents on that machine).
type Group = {
  key: string;
  title: string;
  runnerName: string;
  online: boolean;
  isHost: boolean;
  skills: SlashCommandInfo[];
  commands: SlashCommandInfo[];
};

// Runners report the slash commands/skills they found on disk via heartbeat; GET /runners
// surfaces them per runner, each tagged with its agent. This page flattens that into one
// collapsible group per agent (plus each runner's shared/host bucket) so the catalog reads
// agent-first — what each agent can do — rather than buried under the machine.
export function SkillsPage() {
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const agents = useQuery(agentsQuery());
  const list = runners.data ?? [];

  // agentId -> display name, so a project group reads as the agent, not a uuid.
  const agentName = (id: string): string =>
    (agents.data ?? []).find((a: { id: string }) => a.id === id)?.name ?? id;

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (it: SlashCommandInfo) =>
    !q ||
    it.name.toLowerCase().includes(q) ||
    (it.description?.toLowerCase().includes(q) ?? false);

  // Collapsed group keys; an active search forces every matching group open.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderGroup = (title: string, items: SlashCommandInfo[], keyPrefix: string) => {
    if (items.length === 0) return null;
    return (
      <div className="skills-group">
        <div className="skills-group-title">{title}</div>
        {items.map((it) => (
          <SkillRow item={it} key={`${keyPrefix}:${it.name}`} />
        ))}
      </div>
    );
  };

  // Flatten every runner's (search-filtered) assets into per-scope groups: one per agent
  // that owns project assets, plus the runner's host bucket. Agents sort first by name;
  // the shared/host buckets sink to the bottom.
  const groups: Group[] = [];
  for (const r of list) {
    const skills = (r.skills ?? []).filter(match);
    const commands = (r.commands ?? []).filter(match);
    const byScope = new Map<string, Group>();
    const bucket = (agentId?: string): Group => {
      const id = agentId || '';
      let g = byScope.get(id);
      if (!g) {
        g = {
          key: `${r.id}:${id || 'host'}`,
          title: id ? agentName(id) : 'Shared',
          runnerName: r.displayName || r.name,
          online: !!r.online,
          isHost: !id,
          skills: [],
          commands: [],
        };
        byScope.set(id, g);
      }
      return g;
    };
    for (const s of skills) bucket(s.agentId).skills.push(s);
    for (const c of commands) bucket(c.agentId).commands.push(c);
    groups.push(...byScope.values());
  }
  groups.sort((a, b) =>
    a.isHost !== b.isHost
      ? a.isHost
        ? 1
        : -1
      : a.title.localeCompare(b.title) || a.runnerName.localeCompare(b.runnerName),
  );

  return (
    <div className="skills-page">
      <h1 className="page-title">Skills</h1>

      {runners.isLoading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : list.length === 0 ? (
        <div className="skills-empty">
          No skills yet — skills come from a runner's <code>.claude/skills/</code> (and
          commands from <code>.claude/commands/</code>). Register a machine to get started.
        </div>
      ) : (
        <>
          <input
            className="skills-search"
            type="text"
            placeholder="Search skills / commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {groups.length === 0 ? (
            <div className="skills-no-match">
              {q
                ? `No skills or commands match "${query}".`
                : 'No skills or commands reported by any runner yet.'}
            </div>
          ) : (
            <div className="skills-list">
              {groups.map((g) => {
                const open = !!q || !collapsed.has(g.key);
                const count = g.skills.length + g.commands.length;
                return (
                  <div className="skills-group-card" key={g.key}>
                    <button
                      type="button"
                      className="skills-group-head"
                      onClick={() => toggle(g.key)}
                      aria-expanded={open}
                    >
                      <span className={`skills-caret${open ? ' open' : ''}`} aria-hidden>
                        ▸
                      </span>
                      <span className="skills-group-name">{g.title}</span>
                      <span className="skills-group-meta">
                        <span
                          className="runner-dot"
                          style={{ background: g.online ? 'var(--success-solid)' : 'var(--dot-idle)' }}
                          title={g.online ? 'Online' : 'Offline'}
                        />
                        {g.runnerName}
                      </span>
                      <span className="skills-group-count">{count}</span>
                    </button>
                    {open && (
                      <div className="skills-group-body">
                        {renderGroup('Skills', g.skills, `${g.key}:s`)}
                        {renderGroup('Commands', g.commands, `${g.key}:c`)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
