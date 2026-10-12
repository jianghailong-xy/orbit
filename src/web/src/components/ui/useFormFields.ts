import { useRef, useState } from 'react';

/** One check on a field: the message when it fails, null when it passes. */
export type FieldRule<Values> = (value: string, values: Values) => string | null;

type Messages<Values> = { [Name in keyof Values]?: string[] };

/**
 * A form's text fields and their checks, run when the replaced form ran them: a field's on every change
 * of it; a field's again when a field it depends on changes, once it has been changed or checked
 * itself; every field's when the form is submitted (`validate`). `checked` says whether a field has
 * been changed or checked since the form started (or was `reset`), which is when a passed check shows.
 */
export function useFormFields<Values extends Record<string, string>>(
  initial: Values,
  rules: { [Name in keyof Values]?: FieldRule<Values>[] },
  dependsOn: { [Name in keyof Values]?: (keyof Values)[] } = {},
) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Messages<Values>>({});
  const latest = useRef(initial);
  const touched = useRef(new Set<keyof Values>());
  const run = (name: keyof Values, all: Values) =>
    (rules[name] ?? []).map((rule) => rule(all[name], all)).filter((message): message is string => message !== null);
  const set = (name: keyof Values, value: string) => {
    const next = { ...latest.current, [name]: value };
    latest.current = next;
    touched.current.add(name);
    const updates: Messages<Values> = { [name]: run(name, next) } as Messages<Values>;
    for (const field of Object.keys(dependsOn) as (keyof Values)[]) {
      if (dependsOn[field]?.includes(name) && touched.current.has(field)) updates[field] = run(field, next);
    }
    setValues(next);
    setErrors((current) => ({ ...current, ...updates }));
  };
  const validate = () => {
    const all = {} as Messages<Values>;
    for (const name of Object.keys(latest.current) as (keyof Values)[]) {
      touched.current.add(name);
      all[name] = run(name, latest.current);
    }
    setErrors(all);
    return Object.values(all).every((messages) => !messages?.length);
  };
  const reset = () => {
    latest.current = initial;
    touched.current.clear();
    setValues(initial);
    setErrors({});
  };
  return { values, errors, set, validate, reset, checked: (name: keyof Values) => touched.current.has(name) };
}
