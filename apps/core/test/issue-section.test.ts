import { describe, expect, it } from 'vitest'
import { changedSections, ISSUE_BEGIN, ISSUE_END, mergeSection, renderIssueSection, sectionHash, stripCommentMarkers, workItemMarker } from '../src/gitlab/issue-section.js'
import { importedText } from '../src/gitlab/import.js'

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

  it('renders an unreviewed original request under its own heading', () => {
    const s = renderIssueSection({ ...base, requirements: null, originalRequest: 'คำขอเดิม X' })
    expect(s).toContain('### คำขอเดิม (ยังไม่ผ่านการทบทวน) / Original request (not reviewed)')
    expect(s).toContain('คำขอเดิม X')
    expect(s).not.toContain('### ข้อกำหนด / Requirements')
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
    // A stray end marker in the developer's text: appended once, then replaced in place (never appended again).
    const once = mergeSection(`a ${ISSUE_END} b`, section)
    expect(once).toBe(`a ${ISSUE_END} b\n\n${section}`)
    expect(mergeSection(once, section)).toBe(once)
  })

  const old = `${ISSUE_BEGIN}\n${workItemMarker(ID)}\nold\n${ISSUE_END}`

  it('a stray begin marker after the section: the section is replaced in place', () => {
    const body = `dev\n\n${old}\n\nnote ${ISSUE_BEGIN} trailing`
    expect(mergeSection(body, section)).toBe(`dev\n\n${section}\n\nnote ${ISSUE_BEGIN} trailing`)
  })

  it('a stray end marker before the section: the section is replaced in place', () => {
    const body = `dev ${ISSUE_END} text\n\n${old}`
    expect(mergeSection(body, section)).toBe(`dev ${ISSUE_END} text\n\n${section}`)
  })

  it('a begin marker in developer text before the section: the section is replaced in place', () => {
    const body = `dev ${ISSUE_BEGIN} text\n\n${old}\n\nafter`
    expect(mergeSection(body, section)).toBe(`dev ${ISSUE_BEGIN} text\n\n${section}\n\nafter`)
  })

  it('prefers the pair holding this work item marker over another well-formed pair', () => {
    const other = `${ISSUE_BEGIN}\nquoted, no marker\n${ISSUE_END}`
    const body = `${old}\n\n${other}`
    expect(mergeSection(body, section)).toBe(`${section}\n\n${other}`)
  })

  it('a missing end marker: appended once, then no growth on repeated syncs', () => {
    const body = `dev\n\n${ISSUE_BEGIN}\n${workItemMarker(ID)}\nold, end deleted`
    const once = mergeSection(body, section)
    expect(once).toBe(`${body}\n\n${section}`)
    let cur = once
    for (let i = 0; i < 3; i++) cur = mergeSection(cur, section)
    expect(cur).toBe(once)
    expect(cur.split(ISSUE_END)).toHaveLength(2)
  })
})

describe('untrusted text', () => {
  const nested = '<!-<!---' + '- yoda ---->>'

  it('stripCommentMarkers removes markers until none can reassemble', () => {
    const out = stripCommentMarkers(nested)
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('-->')
    expect(stripCommentMarkers(`a ${ISSUE_BEGIN} b <!<!---->-- c`)).not.toMatch(/<!--|-->/)
  })

  it('importedText leaves no comment markers in the title or description', () => {
    const t = importedText({ title: nested, description: `x ${nested} y`, web_url: 'http://gl.test/a/-/issues/1', iid: 1 }, 'a')
    for (const s of [t.title, t.description]) {
      expect(s).not.toContain('<!--')
      expect(s).not.toContain('-->')
    }
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
