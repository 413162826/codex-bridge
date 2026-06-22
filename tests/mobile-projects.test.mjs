import assert from 'node:assert/strict';
import test from 'node:test';

import { orderMobileProjects } from '../src/mobileProjects.js';

test('mobile projects sort by latest activity, not by the current default session', () => {
  const projects = [
    { id: 'alpha', name: 'alpha', path: 'D:\\repo\\alpha', conversationCount: 4, lastActivity: '2026-06-15T08:00:00.000Z' },
    { id: 'beta', name: 'beta', path: 'D:\\repo\\beta', conversationCount: 2, lastActivity: '2026-06-15T10:00:00.000Z' },
    { id: 'gamma', name: 'gamma', path: 'D:\\repo\\gamma', conversationCount: 8, lastActivity: '2026-06-15T09:00:00.000Z' },
  ];

  const ordered = orderMobileProjects(projects, { cwd: 'D:\\repo\\alpha\\packages\\app' });

  assert.deepEqual(ordered.map((project) => project.id), ['beta', 'gamma', 'alpha']);
});

test('mobile projects use conversation count only as a tie breaker', () => {
  const projects = [
    { id: 'alpha', name: 'alpha', path: 'D:\\repo\\alpha', conversationCount: 3, lastActivity: '2026-06-15T10:00:00.000Z' },
    { id: 'beta', name: 'beta', path: 'D:\\repo\\beta', conversationCount: 9, lastActivity: '2026-06-15T10:00:00.000Z' },
    { id: 'gamma', name: 'gamma', path: 'D:\\repo\\gamma', conversationCount: 1, lastActivity: null },
  ];

  const ordered = orderMobileProjects(projects, { projectId: 'beta', cwd: 'D:\\repo\\alpha' });

  assert.deepEqual(ordered.map((project) => project.id), ['beta', 'alpha', 'gamma']);
});
