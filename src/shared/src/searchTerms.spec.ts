import { describe, expect, it } from 'vitest';
import { searchTerms } from './searchTerms';

describe('searchTerms', () => {
  it('splits on whitespace', () => {
    expect(searchTerms('the merge button')).toEqual([['the'], ['merge'], ['button']]);
    expect(searchTerms('  merge  ')).toEqual([['merge']]);
  });

  it('segments Chinese, which is written without spaces', () => {
    expect(searchTerms('会话列表排序')).toEqual([['会话'], ['列表'], ['排序']]);
    expect(searchTerms('中文分词')).toEqual([['中文'], ['分词']]);
  });

  it('drops a particle standing between two words', () => {
    // 的/了 match every second sentence and cannot narrow anything; keeping them would only
    // paint the transcript yellow.
    expect(searchTerms('修复合并按钮的问题')).toEqual([['修复'], ['合并'], ['按钮'], ['问题']]);
    expect(searchTerms('会话的列表')).toEqual([['会话'], ['列表']]);
    expect(searchTerms('日本語のテスト')).toEqual([['日本語'], ['テスト']]);
  });

  it('rejoins a pair of single characters — a compound the dictionary lacks', () => {
    // ICU has no entry for 优化 and returns it as 优 + 化. Dropping those would leave the word out
    // of the match entirely: "搜索优化" would narrow on 搜索 alone.
    expect(searchTerms('搜索优化')).toEqual([['搜索'], ['优化']]);
    expect(searchTerms('优化搜索匹配规则')).toEqual([['优化'], ['搜索'], ['匹配'], ['规则']]);
  });

  it('offers alternatives when a stray character lands against a compound', () => {
    // 数据库优化 segments to 数据 + 库 + 优 + 化. Requiring 库优化 finds nothing; requiring
    // "one of 库优 / 优化" finds the row that says 数据库 … 优化.
    expect(searchTerms('数据库优化')).toEqual([['数据'], ['库优', '优化']]);
    expect(searchTerms('搜索栏优化')).toEqual([['搜索'], ['栏优', '优化']]);
  });

  it('leaves identifiers whole — only a run containing CJK is segmented', () => {
    // ICU would cut `src/web` at the slash and `ABC-123` at the dash. A person searching those
    // is searching for one thing, and the phrase match is what should find it.
    expect(searchTerms('file_path')).toEqual([['file_path']]);
    expect(searchTerms('sessions.service.ts')).toEqual([['sessions.service.ts']]);
    expect(searchTerms('src/web')).toEqual([['src/web']]);
    expect(searchTerms('ABC-123')).toEqual([['ABC-123']]);
  });

  it('segments a mixed run, keeping the identifier inside it intact', () => {
    expect(searchTerms('修复file_path的问题')).toEqual([['修复'], ['file_path'], ['问题']]);
    expect(searchTerms('会话id')).toEqual([['会话'], ['id']]);
  });

  it('leaves space-written Korean to the whitespace split', () => {
    expect(searchTerms('한국어 테스트')).toEqual([['한국어'], ['테스트']]);
  });

  it('deduplicates, so a repeated term is not matched twice', () => {
    expect(searchTerms('merge merge')).toEqual([['merge']]);
    expect(searchTerms('会话 会话列表')).toEqual([['会话'], ['列表']]);
  });

  it('is empty when nothing matchable is left', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
    // One character on its own is neither a compound nor a word worth narrowing on.
    expect(searchTerms('的')).toEqual([]);
  });
});
