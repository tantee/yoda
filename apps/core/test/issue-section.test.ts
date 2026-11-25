import { describe, expect, it } from 'vitest'
import { changedSections, ISSUE_BEGIN, ISSUE_END, mergeSection, renderIssueSection, sectionHash, workItemMarker } from '../src/gitlab/issue-section.js'

const ID = '11111111-2222-4333-8444-555555555555'
const base = {
  workItem: { id: ID, title: 'แก้รายงานแล็บ' },
  projectName: 'ระบบแล็บ',
  portalUrl: 'http://portal.test',
  requirements: 'ต้องแสดงผลแล็บย้อนหลัง 30 วัน',
  design: null,
  decisions: [{ question: 'ใช้ตารางเดิมไหม', decision: 'ใช้ตารางเดิม' }],
  testCases: null,
  siblings: [{ path: 'dept/lab-web', iid: 4, url: 'http://gl.test/dept/lab-web/-/issues/4' }, { path: 'dept/lab-api', iid: null, url: null }],
  feedback: null,
}

describe('renderIssueSection', () => {
  it('is deterministic, between the markers, with the portal link and bilingual headings', () => {
    const a = renderIssueSection(base)
    expect(renderIssueSection({ ...base })).toBe(a)
    expect(a.startsWith(ISSUE_BEGIN)).toBe(true)
    expect(a.endsWith(ISSUE_END)).toBe(true)
    expect(a).toContain(workItemMarker(ID))
    expect(a).toContain(`http://portal.test/work-items/${ID}`)
    expect(a).toContain('แก้รายงานแล็บ')
    for (const h of ['ข้อกำหนด / Requirements', 'การออกแบบ / Design', 'การตัดสินใจ / Decisions', 'กรณีทดสอบ / Test cases', 'งานที่เกี่ยวข้อง / Related issues']) {
      expect(a).toContain(h)
    }
    expect(a).toContain('ต้องแสดงผลแล็บย้อนหลัง 30 วัน')
    expect(a).toContain('ใช้ตารางเดิมไหม')
    expect(a).toContain('[dept/lab-web#4](http://gl.test/dept/lab-web/-/issues/4)')
    expect(a).toContain('dept/lab-api')
    expect(a).toContain('Closes #')
  })

  it('names its own issue in the closing note once the iid is known', () => {
    expect(renderIssueSection({ ...base, iid: 7 })).toContain('`Closes #7`')
  })

  it('clips long documents with a link to the portal', () => {
    const long = 'ก'.repeat(7000)
    const s = renderIssueSection({ ...base, requirements: long })
    expect(s).not.toContain(long)
    expect(s).toContain('ก'.repeat(6000))
    expect(s).toContain('ดูต่อในพอร์ทัล / continued in the portal')
  })

  it('shows the requested changes and keeps markers out of content', () => {
    const s = renderIssueSection({ ...base, feedback: 'ปุ่มพิมพ์ยังไม่ทำงาน', design: `x ${ISSUE_END} y` })
    expect(s).toContain('Changes requested')
    expect(s).toContain('ปุ่มพิมพ์ยังไม่ทำงาน')
    expect(s.indexOf(ISSUE_END)).toBe(s.length - ISSUE_END.length)
  })
})

describe('mergeSection', () => {
  const section = renderIssueSection(base)

  it('replaces only the text between the markers', () => {
    const body = `บันทึกของนักพัฒนา\n\n${ISSUE_BEGIN}\nold\n${ISSUE_END}\n\n- [ ] checklist`
    const merged = mergeSection(body, section)
    expect(merged).toBe(`บันทึกของนักพัฒนา\n\n${section}\n\n- [ ] checklist`)
    expect(mergeSection(merged, section)).toBe(merged)
  })

  it('appends the section when the markers are missing', () => {
    expect(mergeSection('dev text', section)).toBe(`dev text\n\n${section}`)
    expect(mergeSection('', section)).toBe(section)
    // A stray begin marker without an end: the developer's text stays and the section is appended.
    expect(mergeSection(`a ${ISSUE_BEGIN} b`, section)).toBe(`a ${ISSUE_BEGIN} b\n\n${section}`)
  })
})

describe('sectionHash / changedSections', () => {
  it('hashes with sha256 hex', () => {
    expect(sectionHash('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
  })

  it('lists the headings that changed', () => {
    const before = mergeSection('dev', renderIssueSection(base))
    const after = renderIssueSection({ ...base, decisions: [...base.decisions, { question: 'q2', decision: 'd2' }] })
    expect(changedSections(before, after)).toEqual(['การตัดสินใจ / Decisions'])
    expect(changedSections('no markers', after)).toContain('ข้อกำหนด / Requirements')
  })
})
