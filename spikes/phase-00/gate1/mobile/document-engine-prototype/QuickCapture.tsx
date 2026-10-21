import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { plainTextToCanonicalDocument } from '../../web/packages/document-engine/src/plain-text.js';

type Props = {
  initialText?: string;
  onDocumentChange: (document: ReturnType<typeof plainTextToCanonicalDocument>) => void;
};

/** Source-only Phase 00-B Quick Capture adapter; not yet built or tested on iPhone. */
export function QuickCapture({ initialText = '', onDocumentChange }: Props) {
  const [text, setText] = useState(initialText);

  function update(nextText: string) {
    setText(nextText);
    onDocumentChange(plainTextToCanonicalDocument(nextText));
  }

  return (
    <View>
      <TextInput
        accessibilityLabel="Quick Capture note"
        multiline
        onChangeText={update}
        placeholder="Capture a thought…"
        value={text}
      />
    </View>
  );
}
