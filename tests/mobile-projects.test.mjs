import assert from 'node:assert/strict';
import test from 'node:test';

import { orderMobileProjects } from '../src/mobileProjects.js';

test('mobile projects put default session project first, then sort by last activity', () => {
  const projects = [
    { id: 'alpha', name: 'alpha', path: 'D:\\repo\\alpha', lastActivity: '2026-06-15T08:00:00.000Z' },
    { id: 'beta', name: 'beta', path: 'D:\\repo\\beta', lastActivity: '2026-06-15T10:00:00.000Z' },
    { id: 'gamma', name: 'gamma', path: 'D:\\repo\\gamma', lastActivity: '2026-06-15T09:00:00.000Z' },
  ];

  const ordered = orderMobileProjects(projects, { cwd: 'D:\\repo\\alpha\\packages\\app' });

  assert.deepEqual(ordered.map((project) => project.id), ['alpha', 'beta', 'gamma']);
});

test('mobile projects prefer explicit default project id', () => {
  const projects = [
    { id: 'alpha', name: 'alpha', path: 'D:\\repo\\alpha', lastActivity: '2026-06-15T10:00:00.000Z' },
    { id: 'beta', name: 'beta', path: 'D:\\repo\\beta', lastActivity: '2026-06-15T08:00:00.000Z' },
  ];

  const ordered = orderMobileProjects(projects, { projectId: 'beta', cwd: 'D:\\repo\\alpha' });

  assert.deepEqual(ordered.map((project) => project.id), ['beta', 'alpha']);
});
