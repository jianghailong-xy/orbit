import { describe, expect, it } from 'vitest';
import {
  CLAUDE_EXCLUDED_REGIONS,
  CLAUDE_REGION_NAMES,
  CLAUDE_REGIONS_AS_OF,
  CLAUDE_REGIONS_SOURCE_URL,
  CLAUDE_SUPPORTED_COUNTRIES,
  CLAUDE_SUPPORTED_TERRITORIES,
} from './claude-regions';

const listed = CLAUDE_SUPPORTED_COUNTRIES.map(([code]) => code);
const territories = CLAUDE_SUPPORTED_TERRITORIES.map(([code]) => code);

describe('the supported list as copied from Anthropic on 2026-10-31', () => {
  it('names its source and the day it was copied', () => {
    expect(CLAUDE_REGIONS_SOURCE_URL).toBe('https://www.anthropic.com/legal/supported-regions');
    expect(CLAUDE_REGIONS_AS_OF).toBe('2026-10-31');
  });

  it('holds the page’s 185 entries in its order, each under one ISO 3166-1 code', () => {
    expect(CLAUDE_SUPPORTED_COUNTRIES).toHaveLength(185);
    expect(CLAUDE_SUPPORTED_COUNTRIES[0]).toEqual(['AL', 'Albania']);
    expect(CLAUDE_SUPPORTED_COUNTRIES.at(-1)).toEqual(['ZW', 'Zimbabwe']);
    expect(CLAUDE_SUPPORTED_COUNTRIES).toContainEqual([
      'UA',
      'Ukraine (except Crimea, Donetsk, Kherson, Luhansk, and Zaporizhzhia regions)',
    ]);
    expect(new Set(listed).size).toBe(listed.length);
    for (const code of listed) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it('supports the territories of listed countries, and only those', () => {
    expect(territories).toHaveLength(49);
    expect(new Set(territories).size).toBe(territories.length);
    for (const [code, of] of CLAUDE_SUPPORTED_TERRITORIES) {
      expect(listed, `${code} belongs to ${of}`).toContain(of);
      expect(listed).not.toContain(code);
    }
    // The page's own example.
    expect(CLAUDE_SUPPORTED_TERRITORIES).toContainEqual(['PR', 'US']);
  });

  it('leaves exactly these unsupported: every named code that is neither listed nor a territory', () => {
    const supported = new Set([...listed, ...territories]);
    const unsupported = Object.keys(CLAUDE_REGION_NAMES).filter((code) => !supported.has(code)).sort();
    expect(unsupported).toEqual([
      'AF', 'AQ', 'BY', 'CN', 'CU', 'EH', 'HK', 'IR', 'KP', 'MM', 'MO', 'RU', 'SY', 'VE', 'XK', 'YE',
    ]);
  });

  it('excludes the five Ukrainian regions, Crimea with Sevastopol, by ISO 3166-2 code', () => {
    expect(CLAUDE_EXCLUDED_REGIONS).toEqual([
      ['UA-43', 'Crimea'],
      ['UA-40', 'Sevastopol'],
      ['UA-14', 'Donetsk'],
      ['UA-65', 'Kherson'],
      ['UA-09', 'Luhansk'],
      ['UA-23', 'Zaporizhzhia'],
    ]);
  });
});

describe('display names', () => {
  it('names every listed country and territory', () => {
    for (const code of [...listed, ...territories]) expect(CLAUDE_REGION_NAMES[code], code).toBeTruthy();
    for (const code of Object.keys(CLAUDE_REGION_NAMES)) expect(code).toMatch(/^[A-Z]{2}$/);
    // The 249 ISO 3166-1 codes and Kosovo's XK.
    expect(Object.keys(CLAUDE_REGION_NAMES)).toHaveLength(250);
  });

  it('uses the board’s four names and the plain English name otherwise', () => {
    expect(CLAUDE_REGION_NAMES.CN).toBe('mainland China');
    expect(CLAUDE_REGION_NAMES.HK).toBe('Hong Kong');
    expect(CLAUDE_REGION_NAMES.MO).toBe('Macau');
    expect(CLAUDE_REGION_NAMES.TW).toBe('Taiwan');
    expect(CLAUDE_REGION_NAMES.US).toBe('United States');
    expect(CLAUDE_REGION_NAMES.RU).toBe('Russia');
    expect(CLAUDE_REGION_NAMES.KP).toBe('North Korea');
    expect(CLAUDE_REGION_NAMES.CZ).toBe('Czechia');
    expect(CLAUDE_REGION_NAMES.UA).toBe('Ukraine');
  });

  it('carries no Cloudflare code that names no country', () => {
    expect(CLAUDE_REGION_NAMES.XX).toBeUndefined();
    expect(CLAUDE_REGION_NAMES.T1).toBeUndefined();
  });
});
