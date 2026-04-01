import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import FilePickerModal from '../client/src/components/FilePickerModal.tsx';

function mockJson(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

describe('FilePickerModal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows hidden folders, breadcrumbs, and confirm controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/fs/roots')) {
        return mockJson({ repoRoot: '/workspace', cwd: '/workspace', home: '/Users/test' });
      }
      if (url.startsWith('/api/fs/ls')) {
        return mockJson({
          items: [
            { name: '.tmp', path: '/workspace/.tmp', type: 'dir', size: 0, mtime: new Date().toISOString(), hidden: true },
            { name: 'docs', path: '/workspace/docs', type: 'dir', size: 0, mtime: new Date().toISOString(), hidden: false },
            { name: 'plan.json', path: '/workspace/plan.json', type: 'file', size: 10, mtime: new Date().toISOString(), hidden: false },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    render(
      <MantineProvider>
        <FilePickerModal
          opened
          mode="plan"
          title="Choose plan"
          initialPath="/workspace"
          showHidden
          recentPaths={['/workspace']}
          onChangeShowHidden={() => undefined}
          onRememberPath={() => undefined}
          onClose={() => undefined}
          onPick={() => undefined}
        />
      </MantineProvider>,
    );

    expect(await screen.findByText('.tmp')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '/' })).toBeTruthy();
    expect(screen.getByText('Show hidden folders')).toBeTruthy();
  });

  it('can hide hidden folders', async () => {
    const onChangeShowHidden = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/fs/roots')) {
        return mockJson({ repoRoot: '/workspace', cwd: '/workspace', home: '/Users/test' });
      }
      if (url.startsWith('/api/fs/ls')) {
        return mockJson({
          items: [
            { name: '.tmp', path: '/workspace/.tmp', type: 'dir', size: 0, mtime: new Date().toISOString(), hidden: true },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    render(
      <MantineProvider>
        <FilePickerModal
          opened
          mode="plan"
          title="Choose plan"
          initialPath="/workspace"
          showHidden
          recentPaths={[]}
          onChangeShowHidden={onChangeShowHidden}
          onRememberPath={() => undefined}
          onClose={() => undefined}
          onPick={() => undefined}
        />
      </MantineProvider>,
    );

    const toggle = await screen.findByRole('switch');
    fireEvent.click(toggle);
    expect(onChangeShowHidden).toHaveBeenCalled();
  });
});
