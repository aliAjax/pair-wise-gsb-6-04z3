import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import App from './App';
import { __clearStorageForTests } from './lib/storage';

describe('App 冒烟', () => {
  it('首次渲染不报错，包含关键入口', () => {
    __clearStorageForTests();
    const html = renderToString(createElement(App));
    expect(html).toContain('Type Pairer');
    expect(html).toContain('同步团队库');
    expect(html).toContain('导出 CSS');
    expect(html).toContain('Editorial calm');
  });
});
