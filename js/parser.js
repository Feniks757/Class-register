/**
 * parser.js — Парсер списков студентов из HTML-таблиц (АСУ/деканат) и обычного текста
 */

window.AppParser = (function () {
  'use strict';

  const { formatToInitials } = window.AppUtils;

  function parseStudentsFromHTML(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const students = [];
    let detectedGroupName = '';

    const textContent = doc.body ? doc.body.textContent : '';
    const groupMatches = textContent.match(/групп[аыеу]?\s*[:\-—]?\s*([A-Za-zА-Яа-я0-9\-\/]+)/i) ||
                         textContent.match(/\b([A-ZА-Я]{1,4}\-?\d{2,4}[а-яА-Я]?)\b/);
    if (groupMatches && groupMatches[1]) {
      detectedGroupName = groupMatches[1].trim();
    }

    const rows = doc.querySelectorAll('tr');
    rows.forEach(row => {
      const cells = row.querySelectorAll('td, th');
      if (cells.length < 2) return;

      for (let i = 0; i < cells.length; i++) {
        const text = cells[i].textContent.trim();
        if (/^(студент|фио|ф\.и\.о\.|№|п\/п|номер|код|статус|группа)/i.test(text)) {
          return;
        }
      }

      for (let i = 0; i < cells.length; i++) {
        const cellText = cells[i].textContent.trim().replace(/\s+/g, ' ');
        if (!cellText) continue;

        if (/^[А-ЯЁ][а-яё\-]+(\s+[А-ЯЁ][а-яё\-]+){1,2}$/.test(cellText)) {
          const initials = formatToInitials(cellText);
          if (!students.includes(initials)) {
            students.push(initials);
          }
          break;
        }

        if (/^[А-ЯЁ][\.\s]+[А-ЯЁ][\.\s]+[А-ЯЁ][\.]?$/.test(cellText) || /^[А-ЯЁ][\.\s]+[А-ЯЁ][\.]?$/.test(cellText)) {
          const initials = formatToInitials(cellText);
          if (!students.includes(initials)) {
            students.push(initials);
          }
          break;
        }
      }
    });

    if (students.length === 0) {
      return parseStudentsFromText(textContent);
    }

    return { groupName: detectedGroupName, students };
  }

  function parseStudentsFromText(rawText) {
    const students = [];
    let detectedGroupName = '';

    const groupMatch = rawText.match(/групп[аыеу]?\s*[:\-—]?\s*([A-Za-zА-Яа-я0-9\-\/]+)/i) ||
                       rawText.match(/\b([A-ZА-Я]{1,4}\-?\d{2,4}[а-яА-Я]?)\b/);
    if (groupMatch && groupMatch[1]) {
      detectedGroupName = groupMatch[1].trim();
    }

    const lines = rawText.split(/[\r\n]+/);
    lines.forEach(line => {
      line = line.trim();
      if (!line) return;

      if (/^(студент|фио|ф\.и\.о\.|список|ведомость|факультет|кафедра|дисциплина)/i.test(line)) {
        return;
      }

      let candidate = '';
      if (line.includes('\t') || line.includes(';')) {
        const parts = line.split(/[\t;]+/).map(p => p.trim()).filter(Boolean);
        const namePart = parts.find(p => /^[А-ЯЁа-яё\s\-]{4,}$/.test(p) && p.split(' ').length >= 2);
        candidate = namePart || parts[parts.length - 1];
      } else {
        candidate = line.replace(/^\d+[\.\)\s\t]+/, '').replace(/^\d{5,}\s+/, '').trim();
      }

      if (candidate && /[А-Яа-яЁё]/.test(candidate) && candidate.length >= 3) {
        candidate = candidate.replace(/\s+/g, ' ');
        const initials = formatToInitials(candidate);
        if (!students.includes(initials)) {
          students.push(initials);
        }
      }
    });

    return { groupName: detectedGroupName, students };
  }

  function parseFileContent(content) {
    if (content.includes('<table') || content.includes('<!DOCTYPE') || content.includes('<html')) {
      return parseStudentsFromHTML(content);
    }
    return parseStudentsFromText(content);
  }

  return {
    parseStudentsFromHTML,
    parseStudentsFromText,
    parseFileContent
  };
})();
