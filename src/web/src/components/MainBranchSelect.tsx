import { useState, type JSX } from 'react';
import type { ProjectBranchCandidates } from '@orbit/shared';
import {
  RUN_LAST_CHOSEN,
  RUN_MAIN_BRANCH,
  RUN_MAIN_BRANCH_HINT,
  RUN_TYPE_A_BRANCH,
  runBranchesIn,
  runUseBranch,
} from '../lib/projectStart';
import { Combobox } from './ui/Combobox';

/** Near enough to git's rule for a branch name to refuse a typo before the door does (which takes
 *  any `refs/heads/` name without whitespace): no whitespace, no `~ ^ : ? * [` or backslash, no
 *  `..`, no leading `-` or `/`, no trailing `/` or `.lock`. */
const BRANCH_NAME = /^(?![-/])(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[^\s~^:?*[\\]+$/u;

/**
 * The main branch, picked from the branches the runner reported for the coordination workspace's
 * checkout — the list the session Merge menu offers — or typed when the one wanted is not there (or
 * no runner reported any). The branch the owner chose last for the repository is tagged, as the
 * Merge menu tags its selected target. One control for the start card and How it runs, so the two
 * cannot offer different branches.
 */
export function MainBranchSelect({
  value,
  branches,
  remembered = null,
  disabled = false,
  className,
  onChange,
}: {
  value: string;
  branches: ProjectBranchCandidates | null;
  /** The branch last chosen for this repository, tagged in the list. */
  remembered?: string | null;
  disabled?: boolean;
  className?: string;
  onChange: (name: string) => void;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const names = [...new Set([...(branches?.names ?? []), ...(remembered ? [remembered] : []), value])];
  const typed = search.trim();
  // A branch is listed by its name; a typed one the runner never reported is offered as itself, so
  // its label is the only one that is not its name.
  const options = [
    ...names.map((name) => ({ value: name, label: name })),
    ...(typed && !names.includes(typed) && BRANCH_NAME.test(typed)
      ? [{ value: typed, label: runUseBranch(typed) }]
      : []),
  ];
  return (
    <Combobox
      className={['main-branch-select', className].filter(Boolean).join(' ')}
      aria-label={RUN_MAIN_BRANCH}
      value={value}
      disabled={disabled}
      matchTriggerWidth={false}
      options={options}
      onSearch={setSearch}
      // A main branch is never none: a value the list clears is not a choice.
      onValueChange={(name) => {
        if (name) onChange(name);
      }}
      renderValue={(name) => <span className="main-branch-option">{name}</span>}
      renderOption={(option) => (option.label === option.value ? (
        <span className="main-branch-choice">
          <span className="main-branch-option">{option.value}</span>
          {option.value === remembered ? <span className="main-branch-tag">{RUN_LAST_CHOSEN}</span> : null}
        </span>
      ) : (
        <span className="main-branch-option is-typed">{option.label}</span>
      ))}
      header={
        <div className="main-branch-menu-head">
          {branches ? runBranchesIn(branches.workspaceName) : RUN_TYPE_A_BRANCH}
        </div>
      }
      footer={<div className="main-branch-menu-foot">{RUN_MAIN_BRANCH_HINT}</div>}
    />
  );
}
