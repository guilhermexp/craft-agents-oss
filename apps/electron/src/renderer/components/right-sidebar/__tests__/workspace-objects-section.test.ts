import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types';
import { WorkspaceObjectListLoader, type WorkspaceObjectListLoadCallbacks } from '../workspace-objects-section.tsx';
import * as previewPanelModule from '../workspace-object-preview-panel.tsx';
import {
  buildWorkspaceObjectPreviewRevisions,
  isWorkspaceObjectPreviewDataCurrent,
  workspaceObjectPreviewRenderKey,
} from '../workspace-object-preview-panel.tsx';
import * as relationOptionsModule from '../../workspace-objects/relation-options.ts';
import {
  collectReferencedRelationEntryIds,
  loadReferencedRelationOptions,
  RelationOptionLoadError,
} from '../../workspace-objects/relation-options.ts';
import { contentTabId } from '../../app-shell/content-tabs-state.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function object(id: string, revision: number): WorkspaceObjectPayload {
  return { id, slug: id, name: id, revision, projectionStatus: 'ready', fields: [], entries: [], savedViews: [] };
}

function stateCallbacks(state: {
  objects: WorkspaceObjectPayload[];
  loading: boolean;
  error: Error | null;
  resets: number;
}): WorkspaceObjectListLoadCallbacks {
  return {
    onStart: () => { state.loading = true; state.error = null; },
    onSuccess: objects => { state.objects = objects; },
    onError: error => { state.error = error; },
    onFinish: () => { state.loading = false; },
    onReset: () => { state.objects = []; state.loading = false; state.error = null; state.resets += 1; },
  };
}

describe('WorkspaceObjectListLoader', () => {
  test('only the latest generation applies objects and loading state', async () => {
    const first = deferred<WorkspaceObjectPayload[]>();
    const second = deferred<WorkspaceObjectPayload[]>();
    let calls = 0;
    const loader = new WorkspaceObjectListLoader(async () => (++calls === 1 ? first.promise : second.promise));
    const state = { objects: [] as WorkspaceObjectPayload[], loading: false, error: null as Error | null, resets: 0 };
    const callbacks = stateCallbacks(state);

    const oldLoad = loader.load('workspace-one', callbacks);
    const newLoad = loader.load('workspace-one', callbacks);
    second.resolve([object('new', 2)]);
    await newLoad;
    expect(state).toMatchObject({ objects: [{ id: 'new', revision: 2 }], loading: false, error: null });

    first.resolve([object('old', 1)]);
    await oldLoad;
    expect(state).toMatchObject({ objects: [{ id: 'new', revision: 2 }], loading: false, error: null });
  });

  test('empty workspace resets state and invalidates an in-flight load', async () => {
    const pending = deferred<WorkspaceObjectPayload[]>();
    const loader = new WorkspaceObjectListLoader(async () => pending.promise);
    const state = { objects: [object('stale', 1)], loading: false, error: new Error('old') as Error | null, resets: 0 };
    const callbacks = stateCallbacks(state);

    const oldLoad = loader.load('workspace-one', callbacks);
    await loader.load(null, callbacks);
    expect(state).toEqual({ objects: [], loading: false, error: null, resets: 1 });

    pending.resolve([object('late', 2)]);
    await oldLoad;
    expect(state).toEqual({ objects: [], loading: false, error: null, resets: 1 });
  });

  test('catches rejection, preserves stale objects, exposes error, and allows retry', async () => {
    let calls = 0;
    const loader = new WorkspaceObjectListLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('list unavailable');
      return [object('recovered', 3)];
    });
    const state = { objects: [object('stale', 2)], loading: false, error: null as Error | null, resets: 0 };
    const callbacks = stateCallbacks(state);

    await loader.load('workspace-one', callbacks);
    expect(state).toMatchObject({ objects: [{ id: 'stale' }], loading: false, error: { message: 'list unavailable' } });

    await loader.load('workspace-one', callbacks);
    expect(state).toMatchObject({ objects: [{ id: 'recovered', revision: 3 }], loading: false, error: null });
  });
});

describe('workspace object preview target identity', () => {
  test('seeds relation revisions from the loaded option pages', () => {
    const payload: WorkspaceObjectPayload = {
      ...object('object_people', 3),
      fields: [{ id: 'field_company', name: 'Company', type: 'relation', relationObjectId: 'object_companies' }],
    };
    const pages = {
      object_companies: { options: [], nextCursor: null, revision: 7 },
    };
    const revisions = buildWorkspaceObjectPreviewRevisions(payload, pages);
    const observedProjectionError = buildWorkspaceObjectPreviewRevisions(payload, pages, new Map([
      ['object_companies', { revision: 7, projectionStatus: 'projection-error' as const }],
    ]));

    expect(revisions).toEqual(new Map([
      ['object_people', { revision: 3, projectionStatus: 'ready' }],
      ['object_companies', { revision: 7 }],
    ]));
    expect(observedProjectionError.get('object_companies')).toEqual({ revision: 7, projectionStatus: 'projection-error' });
  });

  test('keeps the primary revision and projection status authoritative for self-relations', () => {
    const payload: WorkspaceObjectPayload = {
      ...object('object_people', 3),
      projectionStatus: 'projection-error',
      fields: [{ id: 'field_manager', name: 'Manager', type: 'relation', relationObjectId: 'object_people' }],
    };
    const revisions = buildWorkspaceObjectPreviewRevisions(payload, {
      object_people: { options: [], nextCursor: null, revision: 99 },
    });

    expect(revisions).toEqual(new Map([
      ['object_people', { revision: 3, projectionStatus: 'projection-error' }],
    ]));
  });

  test('renders localized preview relation errors and exposes detail only for transport', async () => {
    const Alert = Reflect.get(previewPanelModule, 'WorkspaceObjectPreviewErrorAlert');
    const normalizeError = Reflect.get(relationOptionsModule, 'normalizeRelationOptionFailure');
    expect(Alert).toBeFunction();
    expect(normalizeError).toBeFunction();
    if (typeof Alert !== 'function' || typeof normalizeError !== 'function') return;
    const i18n = createInstance();
    await i18n.init({
      lng: 'pt-BR',
      resources: { 'pt-BR': { translation: {
        'chat.workspaceObjectRelationInvalidResponse': 'Resposta de relação inválida.',
        'chat.workspaceObjectRelationTransportError': 'Não foi possível carregar as relações.',
        'chat.workspaceObjectRetry': 'Tentar novamente',
      } } },
    });

    const invalidMarkup = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(Alert, {
      error: normalizeError(new RelationOptionLoadError('invalid-response')),
      onRetry: () => {},
    })));
    const transportMarkup = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(Alert, {
      error: normalizeError(new Error('ECONNRESET')),
      onRetry: () => {},
    })));

    expect(invalidMarkup).toContain('Resposta de relação inválida.')
    expect(invalidMarkup).not.toContain('invalid-response')
    expect(invalidMarkup).not.toContain('data-object-relation-error-detail="true"')
    expect(transportMarkup).toContain('Não foi possível carregar as relações.')
    expect(transportMarkup).toContain('data-object-relation-error-detail="true"')
    expect(transportMarkup).toContain('ECONNRESET')
  });

  test('includes currently referenced relation ids in bounded option lookups', () => {
    const payload: WorkspaceObjectPayload = {
      ...object('object_people', 1),
      fields: [{ id: 'field_company', name: 'Company', type: 'relation', relationObjectId: 'object_companies' }],
      entries: [{ id: 'entry_person', values: { field_company: 'entry_249' } }],
    };
    expect(collectReferencedRelationEntryIds(payload, 'object_companies')).toEqual(['entry_249']);
  });

  test('loads the normal first page separately and batches every referenced id at 200', async () => {
    const referencedIds = Array.from({ length: 401 }, (_, index) => `entry_${String(index).padStart(3, '0')}`);
    const requests: Array<{ includeEntryIds?: string[] }> = [];
    const page = await loadReferencedRelationOptions('object_companies', referencedIds, async request => {
      requests.push(request);
      if (!request.includeEntryIds) {
        return { relationOptions: [{ id: 'normal_page', label: 'Normal page' }], nextCursor: 'normal_cursor', revision: 7 };
      }
      return {
        relationOptions: request.includeEntryIds.map(id => ({ id, label: `Label ${id}` })),
        nextCursor: null,
        revision: 7,
      };
    });

    expect(requests.map(request => request.includeEntryIds?.length ?? 0)).toEqual([0, 200, 200, 1]);
    expect(page.nextCursor).toBe('normal_cursor');
    expect(page.revision).toBe(7);
    expect(page.options).toHaveLength(402);
    expect(page.options.at(-1)).toEqual({ id: 'entry_400', label: 'Label entry_400' });
  });

  test('rejects the whole referenced lookup when any batch fails', async () => {
    const referencedIds = Array.from({ length: 201 }, (_, index) => `entry_${index}`);
    await expect(loadReferencedRelationOptions('object_companies', referencedIds, async request => {
      if (request.includeEntryIds?.includes('entry_200')) throw new Error('batch unavailable');
      return { relationOptions: [], nextCursor: request.includeEntryIds ? null : 'normal_cursor', revision: 7 };
    })).rejects.toThrow('batch unavailable');
  });

  test('rejects relation batches from different canonical revisions', async () => {
    let requestIndex = 0;
    await expect(loadReferencedRelationOptions('object_companies', ['entry_001'], async request => ({
      relationOptions: request.includeEntryIds ? [{ id: 'entry_001', label: 'One' }] : [],
      nextCursor: request.includeEntryIds ? null : 'normal_cursor',
      revision: requestIndex++ === 0 ? 7 : 8,
    }))).rejects.toMatchObject({ code: 'changed-while-loading' });
  });

  test('never renders data from the previous object and keys saved views independently', () => {
    const data = {
      targetKey: contentTabId({ kind: 'object', workspaceId: 'w1', objectId: 'object_old', viewId: 'view_a' }),
      payload: object('object_old', 1),
    };
    expect(isWorkspaceObjectPreviewDataCurrent(data, { workspaceId: 'w1', objectId: 'object_new', viewId: 'view_a' })).toBe(false);
    expect(isWorkspaceObjectPreviewDataCurrent(data, { workspaceId: 'w1', objectId: 'object_old', viewId: 'view_a' })).toBe(true);
    expect(isWorkspaceObjectPreviewDataCurrent(data, { workspaceId: 'w2', objectId: 'object_old', viewId: 'view_a' })).toBe(false);
    expect(isWorkspaceObjectPreviewDataCurrent(data, { workspaceId: 'w1', objectId: 'object_old', viewId: 'view_b' })).toBe(false);
    expect(workspaceObjectPreviewRenderKey(data.payload, 'view_a')).toBe('object_old:view_a');
    expect(workspaceObjectPreviewRenderKey(data.payload, 'view_b')).toBe('object_old:view_b');
  });
});
