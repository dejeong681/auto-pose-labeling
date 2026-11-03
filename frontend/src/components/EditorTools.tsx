import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { JOINT_NAMES, PoseEditor } from '../pose-editor';
import type { EditorSnapshot } from '../types';

type Props = {
  editor: PoseEditor | null;
  snapshot: EditorSnapshot;
  disabled: boolean;
  onError: (message: string) => void;
  onClassValidity: (valid: boolean) => void;
};

export default function EditorTools({ editor, snapshot, disabled, onError, onClassValidity }: Props) {
  const person = snapshot.people[snapshot.selectedPerson];
  const [classValue, setClassValue] = useState('0');
  const jointSelectRef = useRef<HTMLSelectElement>(null);
  // React의 기본 선택 보정으로 첫 관절이 선택되지 않게, 선택이 없으면 모두 해제합니다.
  useLayoutEffect(() => {
    if (snapshot.selectedJoint < 0 && jointSelectRef.current) jointSelectRef.current.selectedIndex = -1;
  });
  useEffect(() => {
    setClassValue(String(person?.class_id ?? 0));
    onClassValidity(true);
  }, [person, onClassValidity]);

  function applyClass(value = classValue) {
    const number = Number(value);
    if (!value || !Number.isSafeInteger(number) || number < 0) {
      onClassValidity(false);
      onError('클래스 번호는 0 이상의 정수로 입력하세요.');
      return;
    }
    onClassValidity(true);
    editor?.setClass(number);
  }

  return <aside className="editor-tools" aria-label="수동 편집 도구">
    <fieldset id="edit-controls" disabled={disabled}>
      <label htmlFor="person-select">편집할 사람</label>
      <select id="person-select" value={person ? snapshot.selectedPerson : ''} disabled={!person}
        onChange={(event) => editor?.selectPerson(Number(event.target.value))}>
        {snapshot.people.length ? snapshot.people.map((item, index) =>
          <option key={index} value={index}>사람 {index + 1} · 클래스 {item.class_id}</option>) : <option value="">사람 없음</option>}
      </select>
      <div className="class-row">
        <label htmlFor="class-id">클래스 번호</label>
        <input id="class-id" type="number" min="0" step="1" value={classValue} disabled={!person}
          onChange={(event) => {
            const value = event.target.value;
            setClassValue(value);
            const valid = Boolean(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
            onClassValidity(valid);
            // 유효한 번호는 즉시 반영하므로 Ctrl+S를 바로 눌러도 빠지지 않습니다.
            if (valid) editor?.setClass(Number(value));
          }} onBlur={() => applyClass()} />
        <button id="apply-class"  disabled={!person} onClick={() => applyClass()}>적용</button>
      </div>
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
    <p className="edit-help">점은 드래그로 이동합니다. 미지정 관절은 목록에서 선택한 뒤 이미지에 찍으세요. 빈 곳 클릭: 선택 해제 · Ctrl+휠: 확대/축소 · 저장: Ctrl+S · 이전/다음: ← / →</p>
  </aside>;
}
