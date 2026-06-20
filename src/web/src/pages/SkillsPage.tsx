import { useQuery } from '@tanstack/react-query';
import { Spin } from 'antd';
import type { SlashCommandInfo } from '@orbit/shared';
import { api } from '../api';
import type { Runner } from '../components/TasksSidePanel';

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

  const renderGroup = (title: string, items: SlashCommandInfo[]) => {
    if (items.length === 0) return null;
    return (
      <div className="skills-group">
        <div className="skills-group-title">{title}</div>
        {items.map((it) => (
          <div className="skill-item" key={it.name}>
            <span className="skill-name">/{it.name}</span>
            {it.description && <span className="skill-desc">{it.description}</span>}
          </div>
        ))}
      </div>
    );
  };

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
        <div className="skills-list">
          {list.map((r) => {
            const skills = r.skills ?? [];
            const commands = r.commands ?? [];
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
                  <span className="skills-runner-status">{r.online ? 'Online' : 'Offline'}</span>
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
  );
}
