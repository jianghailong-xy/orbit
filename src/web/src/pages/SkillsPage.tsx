import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import { useLayoutEffect, useRef, useState } from 'react';
import type { SlashCommandInfo } from '@orbit/shared';
import { api } from '../api';
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
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// Runners report the slash commands (.claude/commands) and skills (.claude/skills)
// they found on disk via heartbeat; GET /runners surfaces them as runner.commands /
// runner.skills. This page groups that catalog by runner so you can see, per machine,
// which skills and commands are available. (Only name + description are reported — the
// SKILL.md body isn't carried over the heartbeat.)
export function SkillsPage() {
  const runners = useQuery({
    queryKey: ['runners'],
    queryFn: () => api<Runner[]>('/runners'),
    refetchInterval: 15_000,
  });
  const list = runners.data ?? [];

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (it: SlashCommandInfo) =>
    !q ||
    it.name.toLowerCase().includes(q) ||
    (it.description?.toLowerCase().includes(q) ?? false);

  const renderGroup = (title: string, items: SlashCommandInfo[]) => {
    if (items.length === 0) return null;
    return (
      <div className="skills-group">
        <div className="skills-group-title">{title}</div>
        {items.map((it) => (
          <SkillRow item={it} key={it.name} />
        ))}
      </div>
    );
  };

  // Per-runner filtered view; when searching, runners with no match drop out entirely.
  const cards = list
    .map((r) => ({
      runner: r,
      skills: (r.skills ?? []).filter(match),
      commands: (r.commands ?? []).filter(match),
    }))
    .filter((c) => !q || c.skills.length > 0 || c.commands.length > 0);

  return (
    <>
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
            placeholder="搜索技能 / 命令…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {cards.length === 0 ? (
            <div className="skills-no-match">没有匹配「{query}」的技能或命令。</div>
          ) : (
            <div className="skills-list">
              {cards.map(({ runner: r, skills, commands }) => {
                const empty = skills.length === 0 && commands.length === 0;
                return (
                  <div className="skills-runner" key={r.id}>
                    <div className="skills-runner-head">
                      <span
                        className="runner-dot"
                        style={{ background: r.online ? '#2ea121' : '#c0c4cc' }}
                        title={r.online ? 'Online' : 'Offline'}
                      />
                      <span className="skills-runner-name">{r.displayName || r.name}</span>
                      <span className="skills-runner-status">
                        {r.online ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    {renderGroup('Skills', skills)}
                    {renderGroup('Commands', commands)}
                    {empty && (
                      <div className="skills-runner-empty">No skills or commands reported.</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
