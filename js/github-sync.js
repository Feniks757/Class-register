/**
 * github-sync.js — Модуль интеграции и автоматической синхронизации с GitHub REST API
 */

window.AppGitHub = (function () {
  'use strict';

  const { showToast, escapeHtml, utf8ToBase64 } = window.AppUtils;

  function updateGitHubStatusCard(githubSettings) {
    const card = document.getElementById('github-connection-status');
    if (!card) return;
    const { owner, repo, token } = githubSettings;
    if (owner && repo && token) {
      card.className = 'github-status-card connected';
      card.innerHTML = `<span>🟢 Интеграция настроена: <b>${escapeHtml(owner)}/${escapeHtml(repo)}</b></span>`;
    } else {
      card.className = 'github-status-card disconnected';
      card.innerHTML = `<span>⚪ Интеграция не настроена (введите токен и репозиторий)</span>`;
    }
  }

  async function testGitHubConnection(githubSettings) {
    const { owner, repo, token } = githubSettings;
    if (!owner || !repo || !token) {
      showToast('Заполните владельца, репозиторий и токен', 'error');
      return false;
    }

    showToast('Проверяем связь с GitHub...', 'info');
    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (resp.ok) {
        const repoData = await resp.json();
        showToast(`Успешно подключено к репозиторию: ${repoData.full_name}`, 'success');
        updateGitHubStatusCard(githubSettings);
        return true;
      } else {
        const err = await resp.json().catch(() => ({}));
        showToast(`Ошибка подключения: ${err.message || resp.statusText}`, 'error');
        return false;
      }
    } catch (e) {
      showToast(`Сетевая ошибка: ${e.message}`, 'error');
      return false;
    }
  }

  async function commitFileToGitHub({ owner, repo, branch, token, path, contentStr, commitMessage }) {
    let sha = null;
    try {
      const getFileResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (getFileResp.ok) {
        const fileInfo = await getFileResp.json();
        sha = fileInfo.sha;
      }
    } catch (err) {
      console.warn('Could not fetch existing file SHA for GitHub:', err);
    }

    const bodyPayload = {
      message: commitMessage,
      content: utf8ToBase64(contentStr),
      branch: branch
    };
    if (sha) {
      bodyPayload.sha = sha;
    }

    const putResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify(bodyPayload)
    });

    if (!putResp.ok) {
      const errData = await putResp.json().catch(() => ({}));
      throw new Error(errData.message || `HTTP ${putResp.status}`);
    }

    return await putResp.json();
  }

  return {
    updateGitHubStatusCard,
    testGitHubConnection,
    commitFileToGitHub
  };
})();
