import{c as e}from"./rolldown-runtime.eihneIGD.js";import{$t as t,Zt as n}from"./vendor-react.DG7nEFKI.js";import{a as r,c as i,s as a}from"./vendor-styled.c04E6ufi.js";import{$ as o,Kt as s,Qt as c,Wr as l,Yt as u}from"./index.COXoNg68.js";var d=s(),f=e(t());a();var p=e(n());function m(e){return`sidebar-header-${e}`}const h=({id:e,title:t,children:n})=>{let[r,i]=f.useState(!1),[a,o]=l(m(e??``),!1);return f.useEffect(()=>{a||i(!1)},[a]),(0,p.jsxs)(p.Fragment,{children:[(0,p.jsx)(b,{children:(0,p.jsxs)(v,{onClick:f.useCallback(()=>{o(!a)},[a,o]),disabled:!e,children:[t,e&&(0,p.jsx)(y,{$expanded:a,size:20})]})}),a&&(r?n:(0,p.jsx)(_,{children:n}))]})},g=r`
  from {
    opacity: 0;
    transform: translateY(-8px);
  }

  to {
    opacity: 1;
    transform: translateY(0px);
  }
`;var _=i.span`
  animation: ${g} 100ms ease-in-out;
`,v=i.button`
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  user-select: none;
  color: ${c(`sidebarText`)};
  position: relative;
  letter-spacing: 0.03em;
  margin: 0;
  padding-block: 4px;
  padding-inline: 12px 2px;
  border: 0;
  background: none;
  border-radius: 4px;
  -webkit-appearance: none;
  transition: all 100ms ease;
  ${o()}
  ${u(4)}

  &:not(:disabled):hover,
  &:not(:disabled):active {
    color: ${c(`textSecondary`)};
    cursor: var(--pointer);
  }
`,y=i(d.CollapsedIcon)`
  transition:
    opacity 100ms ease,
    transform 100ms ease,
    fill 50ms !important;
  ${e=>!e.$expanded&&`transform: rotate(-90deg);`};
  opacity: 0;

  [dir="rtl"] & {
    ${e=>!e.$expanded&&`transform: rotate(90deg);`};
  }
`,b=i.h3`
  margin: 0;

  &:hover,
  &:focus-within {
    ${y} {
      opacity: 1;
    }
  }
`,x=h;export{m as n,x as t};