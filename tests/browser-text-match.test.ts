import {expect,test} from 'bun:test';
import {matchesBrowserText} from '../scripts/browser-text-match.mjs';
test('normalizes table whitespace while keeping case sensitivity by default',()=>{
 expect(matchesBrowserText('Code\tName\nDepartment','Code Name Department')).toBe(true);
 expect(matchesBrowserText('CODE\tNAME\nDEPARTMENT','Code Name Department')).toBe(false);
 expect(matchesBrowserText('CODE\tNAME\nDEPARTMENT','Code Name Department',true)).toBe(true);
});
test('still fails genuinely missing or wrong headings',()=>{
 expect(matchesBrowserText('CODE NAME STATUS','Code Name Department',true)).toBe(false);
});
