'use strict';
const steps = [
  ['registration','Register','Inspect an interface. Grant nothing automatically.','Registration accepts a contract or asset and inspects its declared methods. It does not deploy a contract or authorize a write.'],
  ['permissions','Permissions','Enable only the methods you intend to use.','Reads and writes have explicit policies. An enabled write method is not an unattended grant; the temporary spending permission used for acceptance was removed.'],
  ['balance','Read','Two adapters. One matching balance.','Soroban XLM balance and classic DEX account balances both returned 9999.9993056 XLM in the recorded snapshot, independently matched against Horizon. No transaction was submitted for these reads.'],
  ['confirmed','Confirm','A successful submission is not the finish line.','The historical one-stroop transfer reached SUCCESS through getTransaction. Its exact fee was 7228 stroops, or 0.0007228 XLM. This showcase reuses that evidence and cannot transfer assets.'],
  ['recovery','Recover','The same hash survives a failed conversation.','A provider interruption did not erase the durable operation. Read-only recovery returned the original hash and exact fee. Earlier provider and arithmetic errors were documented and corrected; no payment was repeated.']
];
let current = 0;
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function selectStep(index, focus = false) {
  current = Math.max(0, Math.min(steps.length-1,index));
  const [id,name,title,description] = steps[current];
  tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===current));tab.tabIndex=i===current?0:-1;});
  const image=document.getElementById('walk-image');
  image.src=`assets/${id}.png`;image.alt=`Actual captured application screen: ${name}. ${title}`;
  document.getElementById('walk-heading').textContent=title;
  document.getElementById('walk-description').textContent=description;
  document.getElementById('walk-count').textContent=`${String(current+1).padStart(2,'0')} / 05`;
  document.getElementById('walk-panel').setAttribute('aria-labelledby',`tab-${id}`);
  for(const key of ['full-image','image-link'])document.getElementById(key).href=`assets/${id}.png`;
  document.getElementById('full-image').setAttribute('aria-label',`Open ${name.toLowerCase()} capture at full size`);
  document.getElementById('previous').disabled=current===0;
  document.getElementById('next').disabled=current===steps.length-1;
  document.getElementById('step-live').textContent=`Step ${current+1} of 5: ${name}`;
  if(focus)tabs[current].focus();
}
tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>selectStep(i));tab.addEventListener('keydown',event=>{let n;if(event.key==='ArrowRight')n=(i+1)%steps.length;if(event.key==='ArrowLeft')n=(i+steps.length-1)%steps.length;if(event.key==='Home')n=0;if(event.key==='End')n=steps.length-1;if(n!==undefined){event.preventDefault();selectStep(n,true);}});});
document.getElementById('previous').addEventListener('click',()=>selectStep(current-1));
document.getElementById('next').addEventListener('click',()=>selectStep(current+1));
