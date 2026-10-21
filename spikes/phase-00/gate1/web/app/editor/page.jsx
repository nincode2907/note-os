'use client';

import { useEffect, useRef, useState } from 'react';
import {
  canonicalDocumentFromTiptapJSON,
  canonicalToMarkdown,
  createTiptapEditor,
  parseCanonicalDocument,
  plainTextToCanonicalDocument,
  serializeCanonicalDocument,
  toTiptapJSON,
} from '../../packages/document-engine/src/index.js';
import fixture from '../../packages/document-engine/fixtures/schema-v1-rich.json';
import styles from './editor.module.css';

const STORAGE_KEY = 'noteos:phase-00-b:canonical-document-v1';

export default function EditorSpikePage() {
  const [readOnlyIssue, setReadOnlyIssue] = useState(null);
  const [rawUnsupported, setRawUnsupported] = useState(null);
  const [canonical, setCanonical] = useState(fixture);
  const [loaded, setLoaded] = useState(false);
  const [plainText, setPlainText] = useState('');
  const [linkHref, setLinkHref] = useState('https://example.test/');
  const [savedState, setSavedState] = useState('Not saved');
  const [markdown, setMarkdown] = useState(null);
  const editorElement = useRef(null);
  const editorRef = useRef(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    let documentToOpen = fixture;
    let issue = null;
    if (saved !== null) {
      const parsed = parseCanonicalDocument(saved);
      if (parsed.status === 'supported') documentToOpen = parsed.document;
      else {
        issue = parsed;
        setReadOnlyIssue(parsed);
        setRawUnsupported(saved);
      }
    }
    setCanonical(documentToOpen);
    if (!issue && editorElement.current) {
      editorRef.current = createTiptapEditor({
        element: editorElement.current,
        document: documentToOpen,
        onUpdate: setCanonical,
      });
    }
    setLoaded(true);
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
      editorElement.current?.replaceChildren();
    };
  }, []);

  function save() {
    if (readOnlyIssue) return;
    const result = serializeCanonicalDocument(canonical);
    if (result.status !== 'serialized') {
      setSavedState(`Save blocked: ${result.validation.issues[0]?.message ?? result.status}`);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, result.json);
    setSavedState(`Saved ${new Date().toLocaleTimeString()}`);
  }

  function reload() {
    window.location.reload();
  }

  function convertPlainText() {
    if (readOnlyIssue) return;
    const next = plainTextToCanonicalDocument(plainText);
    setCanonical(next);
    const converted = toTiptapJSON(next);
    if (converted.status === 'ready') editorRef.current?.commands.setContent(converted.json);
    setSavedState('Text converted in memory; save to persist');
  }

  function exportMarkdown() {
    setMarkdown(readOnlyIssue ? { markdown: null, warnings: [] } : canonicalToMarkdown(canonical));
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Phase 00-B · isolated spike</p>
        <h1>Canonical document editor</h1>
        <p>ProseMirror JSON is the editable source. Markdown is a derived preview.</p>
      </header>

      {readOnlyIssue && (
        <section className={styles.notice} role="status">
          <strong>Read-only document</strong>
          <p>{readOnlyIssue.issues?.[0]?.message ?? 'This document cannot be safely edited by schema v1.'}</p>
          <pre>{rawUnsupported}</pre>
        </section>
      )}

      <div className={styles.toolbar}>
        <button type="button" onClick={save} disabled={!loaded || Boolean(readOnlyIssue)}>Save canonical JSON</button>
        <button type="button" onClick={reload}>Reload local save</button>
        <button type="button" onClick={exportMarkdown}>Preview Markdown</button>
        <span aria-live="polite">{savedState}</span>
      </div>

      <section className={styles.panel}>
        <h2>Rich document</h2>
        {readOnlyIssue ? <p>Editing is disabled to preserve unsupported source data.</p> : (
          <>
            <div className={styles.editorToolbar} aria-label="Document formatting">
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleBold().run()}>Bold</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleItalic().run()}>Italic</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleHeading({ level: 2 }).run()}>Heading</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleBulletList().run()}>Bullet list</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleOrderedList().run()}>Ordered list</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleTaskList().run()}>Checklist</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleBlockquote().run()}>Quote</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().toggleCodeBlock().run()}>Code block</button>
              <button type="button" onClick={() => editorRef.current?.chain().focus().insertContent({ type: 'attachmentReference', attrs: { attachmentId: 'synthetic-asset-01', label: 'sample.png' } }).run()}>Insert test attachment reference</button>
              <label>Link URL <input value={linkHref} onChange={(event) => setLinkHref(event.target.value)} /></label>
              <button type="button" onClick={() => {
                if (!/^(https?:|mailto:|tel:)/i.test(linkHref)) {
                  setSavedState('Link blocked: use http, https, mailto, or tel.');
                  return;
                }
                editorRef.current?.chain().focus().setLink({ href: linkHref }).run();
              }}>Link selection</button>
            </div>
            <div ref={editorElement} className={styles.editor} aria-label="Canonical document editor" />
          </>
        )}
      </section>

      <section className={styles.panel}>
        <h2>Plain text → canonical JSON</h2>
        <textarea value={plainText} onChange={(event) => setPlainText(event.target.value)} rows={4} />
        <button type="button" onClick={convertPlainText} disabled={!loaded || Boolean(readOnlyIssue)}>Convert to document</button>
      </section>

      {markdown && (
        <section className={styles.panel}>
          <h2>Markdown projection</h2>
          <pre>{markdown.markdown ?? 'Projection blocked for unsupported data.'}</pre>
          {markdown.warnings.length > 0 && <ul>{markdown.warnings.map((warning) => <li key={`${warning.code}:${warning.path}`}>{warning.message}</li>)}</ul>}
        </section>
      )}
    </main>
  );
}
