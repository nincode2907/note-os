import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { EDITOR_BRIDGE_VERSION } from './editor-bridge.mjs';

export type EditorCommand = 'INIT_DOCUMENT' | 'SET_EDITABLE' | 'REQUEST_DOCUMENT' | 'SAVE_RESULT' | 'FOCUS_BODY';
export type CanonicalEditorHandle = { requestDocument: (requestId: string) => void; saveResult: (requestId: string, ok: boolean, revision: number, message: string) => void; focusBody: () => void };
type Props = { sessionId: string; document: any; editable: boolean; height: number; onMessage: (event: WebViewMessageEvent) => void; onFailure: (message: string) => void; onInstanceRestart: () => void };

const editorAssetModule = require('./editor/canonical-editor.html');

export const CanonicalEditor = forwardRef<CanonicalEditorHandle, Props>(function CanonicalEditor({ sessionId, document, editable, height, onMessage, onFailure, onInstanceRestart }, ref) {
  const webView = useRef<WebView>(null);
  const failureHandler = useRef(onFailure); failureHandler.current = onFailure;
  const nativeGeneration = useRef(0);
  const didInitialize = useRef(false);
  const loadStarted = useRef(false);
  const restartReported = useRef(false);
  const [html, setHtml] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const asset = Asset.fromModule(editorAssetModule);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (!uri.startsWith('file:')) throw new Error('The bundled editor asset is not available offline on this device.');
        const content = await new File(uri).text();
        if (!content.includes('noteOS') || !content.includes('noteos-editor')) throw new Error('The bundled editor asset did not load correctly.');
        if (active) setHtml(content);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The local editor could not be prepared.';
        if (active) { setLoadError(message); failureHandler.current(message); }
      }
    })();
    return () => { active = false; };
  }, []);

  function send(type: EditorCommand, payload: Record<string, unknown>) {
    const envelope = { v: EDITOR_BRIDGE_VERSION, sessionId, generation: ++nativeGeneration.current, type, payload };
    const serialized = JSON.stringify(envelope);
    if (serialized.length > 2 * 1024 * 1024) { onFailure('Native editor command exceeds the message size limit.'); return; }
    webView.current?.postMessage(serialized);
  }

  function initialize() {
    if (didInitialize.current) return;
    didInitialize.current = true;
    nativeGeneration.current = 1;
    const envelope = { v: EDITOR_BRIDGE_VERSION, sessionId, generation: nativeGeneration.current, type: 'INIT_DOCUMENT', payload: { document, editable } };
    const serialized = JSON.stringify(envelope);
    if (serialized.length > 2 * 1024 * 1024) { onFailure('This note is too large for the local editor bridge. It remains preserved.'); return; }
    webView.current?.postMessage(serialized);
  }

  useEffect(() => { if (didInitialize.current) send('SET_EDITABLE', { editable }); }, [editable]);
  useImperativeHandle(ref, () => ({
    requestDocument: requestId => send('REQUEST_DOCUMENT', { requestId }),
    saveResult: (requestId, ok, revision, message) => send('SAVE_RESULT', { requestId, ok, revision, message: message.slice(0, 500) }),
    focusBody: () => send('FOCUS_BODY', {}),
  }), [sessionId]);

  if (loadError) return <View style={{ minHeight: 100, justifyContent: 'center', padding: 16 }}><Text accessibilityRole="alert">Editor unavailable. Original canonical content is preserved. {loadError}</Text></View>;
  if (!html) return <View style={{ minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 8 }}><ActivityIndicator color="#344D3F" /><Text>Opening the bundled editor…</Text></View>;

  return <WebView
    ref={webView}
    source={{ html, baseUrl: 'about:blank' }}
    originWhitelist={['*']}
    onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
    onLoadStart={() => { if (loadStarted.current && !restartReported.current) { restartReported.current = true; onInstanceRestart(); } else loadStarted.current = true; }}
    onLoadEnd={initialize}
    onMessage={onMessage}
    onError={event => { const message = event.nativeEvent.description || 'The local editor failed to load.'; setLoadError(message); onFailure(message); }}
    onContentProcessDidTerminate={() => onFailure('The editor process restarted. Unsaved changes remain in the recovery journal when its last draft write completed.')}
    scrollEnabled={false}
    bounces={false}
    keyboardDisplayRequiresUserAction={false}
    hideKeyboardAccessoryView
    allowsInlineMediaPlayback
    javaScriptEnabled
    domStorageEnabled={false}
    mixedContentMode="never"
    style={{ height: Math.max(240, Math.min(height, 16000)), backgroundColor: '#F7F5F0' }}
  />;
});
