/**
 * Block-level content controls (`<w:sdt>`) are unwrapped on import — their
 * inner paragraphs/tables come through instead of being silently dropped.
 */
import { describe, expect, it } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocxFull } from '../../src/import/index.js';
import { Docx } from '../../src/ooxml/docx.js';

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const DOC_WITH_SDT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}>
  <w:body>
    <w:p><w:r><w:t>before</w:t></w:r></w:p>
    <w:sdt>
      <w:sdtPr><w:alias w:val="control"/></w:sdtPr>
      <w:sdtContent>
        <w:p><w:r><w:t>inside the control</w:t></w:r></w:p>
      </w:sdtContent>
    </w:sdt>
    <w:p><w:r><w:t>after</w:t></w:r></w:p>
  </w:body>
</w:document>`;

describe('import — block content control (w:sdt)', () => {
  it('unwraps the control and keeps its inner content in order', async () => {
    const base = await Docx.load(
      await toDocx(schema.nodes['doc']!.createChecked(null, [schema.nodes['paragraph']!.create()])),
    );
    base.writeText('word/document.xml', DOC_WITH_SDT);
    const { doc } = await fromDocxFull(await base.toBuffer());
    const text = doc.textContent;
    expect(text).toContain('before');
    expect(text).toContain('inside the control');
    expect(text).toContain('after');
    // Order preserved: the control's content sits between the two plain
    // paragraphs.
    expect(text.indexOf('before')).toBeLessThan(text.indexOf('inside the control'));
    expect(text.indexOf('inside the control')).toBeLessThan(text.indexOf('after'));
  });
});
