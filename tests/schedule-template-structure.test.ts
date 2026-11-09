import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulesPage} from '../src/schedules-panel.ts';

const cards=[
 ['briefing','아침 브리핑','어제 맡긴 일을 아침마다 정리','M12 3v2M5.6 5.6l1.4 1.4M3 12h2M19 12h2M17 7l1.4-1.4M7.5 15a4.5 4.5 0 1 1 9 0M3 19h18'],
 ['weekly-expenses','주간 지출 정리','지난주 지출을 항목별로 묶기','M3.5 6.5h17v11h-17zM3.5 10h17M7 14.5h3'],
 ['price-watch','가격 보기','원하는 값 아래로 내려가면 알림','M3.5 12.5V4.5h8l9 9-8 8zM8 8.5h.01'],
 ['monthly-subscriptions','월말 구독 점검','이번 달 구독 결제 목록','M4.5 5.5h15v15h-15zM4.5 9.5h15M8.5 3.5v4M15.5 3.5v4'],
 ['meeting-preparation','회의 전 자료 모으기','회의 전날 저녁에 자료 모으기','M3.5 6.5h6l2 2h9v10h-17z'],
 ['weekend-groceries','주말 장보기 목록','금요일마다 장보기 목록 만들기','M4 5h2l2 10h10l2-7H7M9 19.5h.01M17 19.5h.01']
] as const;
const renderedCards=[...schedulesPage.matchAll(/<button id="schedule-example-([^"]+)" type="button" class="sched-example">([\s\S]*?)<\/button>/g)];

test('all six schedule cards put a separate title above their description beside one SVG',()=>{
 assert.deepEqual(renderedCards.map(card=>card[1]),cards.map(card=>card[0]));
 for(const [kind,title,description] of cards){
  const body=renderedCards.find(card=>card[1]===kind)![2]!;
  const structure=/^<svg\b[^>]*>([\s\S]*?)<\/svg><span><strong>([^<]+)<\/strong><span>([^<]+)<\/span><\/span>$/.exec(body);
  assert.ok(structure,kind+': SVG and stacked title/description');
  assert.deepEqual(structure.slice(2),[title,description],kind);
  assert.equal((body.match(/<svg\b/g)||[]).length,1,kind);
 }
});

test('each schedule card uses its own artboard icon geometry',()=>{
 for(const [kind,,,path] of cards){
  const body=renderedCards.find(card=>card[1]===kind)![2]!;
  const geometry=/<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(body);
  assert.equal(geometry?.[1],'<path d="'+path+'"/>',kind);
  assert.match(body,/<svg aria-hidden="true" width="18" height="18"/);
 }
});
