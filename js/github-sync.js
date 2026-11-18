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

  /**
   * Загрузка нескольких файлов через Git Data API (Blobs, Trees, Commits).
   * Поддерживает файлы размером до 100 МБ (в отличие от Contents API с лимитом 1 МБ),
   * а также делает единый атомарный коммит для всех переданных файлов (data.json и data.js).
   */
  async function commitMultipleFilesToGitHub({ owner, repo, branch = 'main', token, files, commitMessage }) {
    const authHeaders = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };

    // 1. Получаем текущую ссылку на ветку
    let latestCommitSha = null;
    let baseTreeSha = null;

    try {
      const refResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, {
        headers: authHeaders
      });

      if (refResp.ok) {
        const refData = await refResp.json();
        latestCommitSha = refData.object?.sha;

        if (latestCommitSha) {
          const commitResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${latestCommitSha}`, {
            headers: authHeaders
          });
          if (commitResp.ok) {
            const commitData = await commitResp.json();
            baseTreeSha = commitData.tree?.sha;
          }
        }
      }
    } catch (e) {
      console.warn('Не удалось получить информацию о ветке:', e);
    }

    // Если репозиторий инициализирован и ветка найдена — используем надежный Git Data API (до 100 МБ)
    if (latestCommitSha) {
      // 2. Создаем Blobs для каждого файла
      const treeItems = [];
      for (const file of files) {
        const blobResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            content: utf8ToBase64(file.contentStr),
            encoding: 'base64'
          })
        });

        if (!blobResp.ok) {
          const err = await blobResp.json().catch(() => ({}));
          throw new Error(err.message || `Ошибка создания blob для ${file.path}: HTTP ${blobResp.status}`);
        }

        const blobData = await blobResp.json();
        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha
        });
      }

      // 3. Создаем новое дерево (Tree)
      const treeBody = { tree: treeItems };
      if (baseTreeSha) {
        treeBody.base_tree = baseTreeSha;
      }

      const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(treeBody)
      });

      if (!treeResp.ok) {
        const err = await treeResp.json().catch(() => ({}));
        throw new Error(err.message || `Ошибка создания Git Tree: HTTP ${treeResp.status}`);
      }

      const treeData = await treeResp.json();

      // 4. Создаем новый коммит (Commit)
      const newCommitResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          message: commitMessage,
          tree: treeData.sha,
          parents: [latestCommitSha]
        })
      });

      if (!newCommitResp.ok) {
        const err = await newCommitResp.json().catch(() => ({}));
        throw new Error(err.message || `Ошибка создания коммита: HTTP ${newCommitResp.status}`);
      }

      const newCommitData = await newCommitResp.json();

      // 5. Перемещаем указатель ветки (Refs Heads) на новый коммит
      const updateRefResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({
          sha: newCommitData.sha,
          force: false
        })
      });

      if (!updateRefResp.ok) {
        const err = await updateRefResp.json().catch(() => ({}));
        throw new Error(err.message || `Ошибка обновления ветки ${branch}: HTTP ${updateRefResp.status}`);
      }

      return await updateRefResp.json();
    }

    // Запасной fallback для пустого репозитория без единого коммита: используем Contents API
    for (const file of files) {
      await commitSingleFileViaContentsApi({
        owner,
        repo,
        branch,
        token,
        path: file.path,
        contentStr: file.contentStr,
        commitMessage
      });
    }
  }

  async function commitSingleFileViaContentsApi({ owner, repo, branch, token, path, contentStr, commitMessage }) {
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

  async function commitFileToGitHub({ owner, repo, branch, token, path, contentStr, commitMessage }) {
    return commitMultipleFilesToGitHub({
      owner,
      repo,
      branch,
      token,
      files: [{ path, contentStr }],
      commitMessage
    });
  }

  return {
    updateGitHubStatusCard,
    testGitHubConnection,
    commitFileToGitHub,
    commitMultipleFilesToGitHub
  };
})();
