//브랜치 수정확인작업222
import { useLayoutEffect, useRef } from 'react';
import { JOINT_NAMES, PoseEditor } from '../pose-editor';
import type { EditorSnapshot } from '../types';

type Props = {
  editor: PoseEditor | null;
  snapshot: EditorSnapshot;
  disabled: boolean;
};

// 선택할 클래스 번호입니다. 새 클래스를 사용하면 이 배열에 번호를 추가하세요.
const CLASS_IDS = [0, 1];

export default function EditorTools({ editor, snapshot, disabled }: Props) {
  const person = snapshot.people[snapshot.selectedPerson];
  // 기존 라벨에 다른 번호가 있어도 현재 값을 잃지 않도록 목록에 함께 표시합니다.
  const classIds = [...new Set([...CLASS_IDS, ...snapshot.people.map((item) => item.class_id)])].sort((a, b) => a - b);
  const jointSelectRef = useRef<HTMLSelectElement>(null);
  // React의 기본 선택 보정으로 첫 관절이 선택되지 않게, 선택이 없으면 모두 해제합니다.
  useLayoutEffect(() => {
    if (snapshot.selectedJoint < 0 && jointSelectRef.current) jointSelectRef.current.selectedIndex = -1;
  });

  return <aside className="editor-tools" aria-label="수동 편집 도구">
    <fieldset id="edit-controls" disabled={disabled}>
      <label htmlFor="person-select">편집할 사람</label>
      <select id="person-select" value={person ? snapshot.selectedPerson : ''} disabled={!person}
        onChange={(event) => editor?.selectPerson(Number(event.target.value))}>
        {snapshot.people.length ? snapshot.people.map((item, index) =>
          <option key={index} value={index}>사람 {index + 1} · 클래스 {item.class_id}</option>) : <option value="">사람 없음</option>}
      </select>
      <label htmlFor="class-id">클래스 번호</label>
      <select id="class-id" value={person?.class_id ?? ''} disabled={!person}
        onChange={(event) => editor?.setClass(Number(event.target.value))}>
        {!person && <option value="">사람 없음</option>}
        {classIds.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      <div className="tool-buttons">
        <button id="add-person"  onClick={() => editor?.startBox('add')}>사람 추가</button>
        <button id="replace-box"  disabled={!person} onClick={() => editor?.startBox('replace')}>박스 다시 그리기</button>
        <button id="delete-person"  className="danger" disabled={!person} onClick={() => {
          if (window.confirm('선택한 사람의 박스와 관절을 삭제할까요?')) editor?.deletePerson();
        }}>사람 삭제</button>
      </div>
      <p id="edit-mode" className="edit-mode">{snapshot.mode === 'point' ? '관절 편집' :
      snapshot.mode === 'add' ? '사람 박스 추가 중 · Esc로 취소' : '박스 다시 그리는 중 · Esc로 취소'}</p>
      <label htmlFor="joint-select">관절 · 사람 자신의 좌우 기준</label>
      <select ref={jointSelectRef} id="joint-select" size={8} value={snapshot.selectedJoint} disabled={!person}
        onChange={(event) => editor?.selectJoint(Number(event.target.value))}>
        {JOINT_NAMES.map((name, index) => <option key={index} value={index}>
          {index}. {name} · {person?.keypoints[index].v ? '지정' : '미지정'}
        </option>)}
      </select>
      <button id="clear-joint"  disabled={!person || snapshot.selectedJoint < 0} onClick={() => editor?.clearJoint()}>선택 관절 미지정 (0)</button>
    </fieldset>
    <p className="edit-help">점은 드래그로 이동합니다. 미지정 관절을 찍으면 다음 관절이 선택됩니다. 관절 선택: ↑ / ↓ · 빈 곳 클릭: 선택 해제 · Ctrl+휠: 확대/축소 · 저장: Ctrl+S · 이전/다음 이미지: ← / →</p>
  </aside>;
}
