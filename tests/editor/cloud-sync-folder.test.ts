import { describe, expect, it } from 'vitest';
import {
  cloudSyncFolderLabel,
  cloudSyncCoEditWarning,
} from '../../src/editor/cloud-sync-folder.js';

describe('cloudSyncFolderLabel', () => {
  it('detects the common providers on POSIX and Windows paths', () => {
    expect(cloudSyncFolderLabel('/Users/ethan/Dropbox/Debate/1AC.cmir')).toBe('Dropbox');
    expect(cloudSyncFolderLabel('C:\\Users\\ethan\\Dropbox\\Debate\\1AC.cmir')).toBe('Dropbox');
    expect(cloudSyncFolderLabel('C:\\Users\\ethan\\OneDrive\\x.cmir')).toBe('OneDrive');
    expect(cloudSyncFolderLabel('/Users/e/Google Drive/x.cmir')).toBe('Google Drive');
  });

  it('detects the decorated folder names the providers actually create', () => {
    // Real-world: "Dropbox (Personal)", "OneDrive - Contoso", team folders.
    expect(cloudSyncFolderLabel('/Users/e/Dropbox (Personal)/x.cmir')).toBe('Dropbox');
    expect(cloudSyncFolderLabel('C:\\Users\\e\\OneDrive - Contoso\\x.cmir')).toBe('OneDrive');
    expect(cloudSyncFolderLabel('/Users/e/Dropbox (UMich Debate)/cp.cmir')).toBe('Dropbox');
  });

  it("detects macOS iCloud Drive's on-disk location", () => {
    expect(
      cloudSyncFolderLabel('/Users/e/Library/Mobile Documents/com~apple~CloudDocs/x.cmir'),
    ).toBe('iCloud Drive');
  });

  it('is case-insensitive', () => {
    expect(cloudSyncFolderLabel('/users/e/dropbox/x.cmir')).toBe('Dropbox');
    expect(cloudSyncFolderLabel('/users/e/DROPBOX/x.cmir')).toBe('Dropbox');
  });

  it('does NOT flag unrelated folders that merely start with a provider name', () => {
    // The whole point of matching a path SEGMENT: a false positive here would
    // nag the user about a perfectly safe local file.
    expect(cloudSyncFolderLabel('/Users/e/Documents/dropbox-notes.cmir')).toBeNull();
    expect(cloudSyncFolderLabel('/Users/e/dropboxes/x.cmir')).toBeNull();
    expect(cloudSyncFolderLabel('/Users/e/onedriver/x.cmir')).toBeNull();
    expect(cloudSyncFolderLabel('/Users/e/Debate/1AC.cmir')).toBeNull();
  });

  it('handles empty / missing paths without throwing', () => {
    expect(cloudSyncFolderLabel(null)).toBeNull();
    expect(cloudSyncFolderLabel(undefined)).toBeNull();
    expect(cloudSyncFolderLabel('')).toBeNull();
  });
});

describe('cloudSyncCoEditWarning', () => {
  it('names the provider and the file, and says what to do', () => {
    const msg = cloudSyncCoEditWarning('Dropbox', '1AC.cmir');
    expect(msg).toContain('1AC.cmir');
    expect(msg).toContain('Dropbox');
    // The actionable instruction, not just a scary noise message.
    expect(msg).toMatch(/Move it to a folder that isn't shared/);
  });
});
