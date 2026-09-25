import { useState } from 'react';
import { App, Button, Input, Modal, Select } from 'antd';
import { KIND_SPECS, WIKI_LIMITS, type WikiFieldSchema, type WikiKind } from '@orbit/shared';
import { WIKI_KIND_LABELS, WIKI_NEW_ENTRY, wikiKindWord } from '../lib/wiki';
import { proposeToWiki, useWikiWrite, wikiIdempotencyKey } from '../lib/wikiWrites';

/**
 * The owner writing an entry of their own, from the home page's header.
 *
 * THE FORM IS THE KIND'S SCHEMA, walked rather than typed out: `KIND_SPECS` is what the write door
 * validates against, so a kind that grows a field grows an input here with nothing to keep in step —
 * which is the failure a hand-written form per kind invites and cannot detect.
 *
 * THREE KINDS ARE OFFERED, and it is a scope statement rather than a rule: a decision needs its
 * rejected alternatives, a pitfall the trigger and the run that hit it, a recipe the command that
 * checks it — all of which are things a session has and a form does not, and the design's own way in
 * for them is `wiki_propose` from the session that hit them (§8.1). The three below are the ones an
 * owner writes out of their own head, and a principle is theirs alone anyway
 * (`KIND_SPECS.principle.ownerOnlyOps`).
 */
export function WikiNewEntryButton({ spaceId }: { spaceId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)}>
        {WIKI_NEW_ENTRY}
      </Button>
      {open && <NewEntryModal spaceId={spaceId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The kinds this form writes, in the order the picker lists them. */
export const WIKI_AUTHORED_KINDS: readonly WikiKind[] = ['principle', 'convention', 'concept'];

function NewEntryModal({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const [kind, setKind] = useState<WikiKind>('principle');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const { message } = App.useApp();
  const write = useWikiWrite((body: Parameters<typeof proposeToWiki>[1]) => proposeToWiki(spaceId, body));

  const spec = KIND_SPECS[kind];
  const submit = async () => {
    try {
      await write.mutateAsync({
        rationale: `the owner records a ${kind}`,
        idempotencyKey: wikiIdempotencyKey('wiki-new'),
        ops: [{ op: 'add', entry: { kind, title: title.trim(), summary: summary.trim(), fields } as never }],
      });
      message.success('Recorded');
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  return (
    <Modal
      open
      title={WIKI_NEW_ENTRY}
      onCancel={onClose}
      onOk={submit}
      okText="Record"
      okButtonProps={{ disabled: !title.trim() || !summary.trim() }}
      confirmLoading={write.isPending}
      destroyOnHidden
      width={560}
    >
      <div className="wk-form">
        <label className="k">Kind</label>
        <Select
          value={kind}
          onChange={(next) => {
            setKind(next);
            setFields({});
          }}
          options={WIKI_AUTHORED_KINDS.map((k) => ({ value: k, label: WIKI_KIND_LABELS[k] }))}
        />
        <label className="k">Title</label>
        <Input
          value={title}
          maxLength={WIKI_LIMITS.titleMaxChars}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="k">One line</label>
        <Input.TextArea rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} />
        {Object.entries(spec.fields).map(([name, schema]) => (
          <SchemaInput
            key={name}
            name={name}
            schema={schema}
            value={fields[name]}
            onChange={(value) => setFields((previous) => ({ ...previous, [name]: value }))}
          />
        ))}
        <p className="wk-modal-note">
          Recorded as yours ({wikiKindWord(kind).toLowerCase()}), live at once. A decision, a pitfall or
          a recipe is recorded where it was hit, by the session that hit it.
        </p>
      </div>
    </Modal>
  );
}

/** One field of the kind's schema, as the input its type asks for. */
function SchemaInput({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: WikiFieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = name.charAt(0).toUpperCase() + name.slice(1).replace(/([A-Z])/gu, ' $1').toLowerCase();
  const required = schema.required ? '' : ' (optional)';
  if (schema.type === 'textList') {
    const lines = Array.isArray(value) ? (value as string[]).join('\n') : '';
    return (
      <>
        <label className="k">
          {label}
          {required}
        </label>
        <Input.TextArea
          rows={3}
          value={lines}
          placeholder="One per line"
          onChange={(event) =>
            onChange(
              event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        />
      </>
    );
  }
  if (schema.type === 'text') {
    return (
      <>
        <label className="k">
          {label}
          {required}
        </label>
        <Input.TextArea
          rows={2}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </>
    );
  }
  // A type this phase's three authored kinds do not carry. Declared rather than silently dropped:
  // a field the form cannot express is a field the proposal would be refused for.
  return (
    <>
      <label className="k">
        {label}
        {required}
      </label>
      <div className="wk-note-dim">This kind's {label.toLowerCase()} is not editable here yet.</div>
    </>
  );
}
