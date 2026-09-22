// Match visible text independently of tabs/newlines inserted by browser layout.
export function matchesBrowserText(actual,expected,ignoreCase=false){
 const normalize=value=>String(value).replace(/\s+/gu,' ').trim();
 const a=normalize(actual),e=normalize(expected);
 return ignoreCase?a.toLowerCase().includes(e.toLowerCase()):a.includes(e);
}
