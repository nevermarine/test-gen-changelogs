// Copyright 2022 Flant JSC
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//@ts-check
//
const {
  knownLabels,
  skipE2eLabel,
  userClusterLabels
} = require('./constants');

const e2eStatus = require('./e2e-commit-status');

const {
  commentLabelRecognition,
} = require('./comments');

/* 
 * this file contains only 3 functions from the original ci.js: 
 * extractCommandFromComment, reactToComment, startWorkflow.
 * original ci.js file can be found here:
 * https://github.com/deckhouse/deckhouse/blob/main/.github/scripts/js/ci.js
*\

/*
 * Extract argv slash command array from comment.
 *
 * @param {string} comment - A comment body.
 * @returns {object}
 */

const { dumpError } = require('./error');
const extractCommandFromComment = (comment) => {
	// Split comment to lines.
	const lines = comment.split(/\r\n|\n|\r/).filter(l => l.startsWith('/'));
	if (lines.length < 1) {
	  return {'err': 'first line is not a slash command'}
	}
  
	// Search for user command in the first line of the comment.
	// User command is a command and a tag name.
	const argv = lines[0].split(/\s+/);
  
	if ( ! /^\/[a-z\d_\-\/.,]+$/.test(argv[0])) {
	  return {'err': 'not a slash command in the first line'};
	}
  
	return {argv, lines}
};
  
module.exports.extractCommandFromComment = extractCommandFromComment;

/**
 * Set reaction to issue comment.
 *
 * @param {object} inputs
 * @param {object} inputs.github - A pre-authenticated octokit/rest.js client with pagination plugins.
 * @param {object} inputs.context - An object containing the context of the workflow run.
 * @param {object} inputs.comment_id - ID of the issue comment.
 * @param {object} inputs.content - Reaction type: (+1, -1, rocket, confused, ...).
 * @returns {Promise<void|*>}
 */
const reactToComment = async ({github, context, comment_id, content}) => {
	return await github.rest.reactions.createForIssueComment({
	  owner: context.repo.owner,
	  repo: context.repo.repo,
	  comment_id,
	  content,
	});
};
module.exports.reactToComment = reactToComment;


const checkUserClusterLabel = async ({github, context, core, prLabels}) => {
    const userLabelsInPR = prLabels
        .map(label => label.name)
        .filter(labelName => userClusterLabels[labelName]);
    return userLabelsInPR;
};
  
/**
 * Start workflow using workflow_dispatch event.
 *
 * @param {object} args
 * @param {object} args.github - A pre-authenticated octokit/rest.js client with pagination plugins.
 * @param {object} args.context - An object containing the context of the workflow run.
 * @param {object} args.core - A reference to the '@actions/core' package.
 * @param {object} args.workflow_id - A name of the workflow YAML file.
 * @param {object} args.ref - A Git ref.
 * @param {object} args.inputs - Inputs for the workflow_dispatch event.
 * @returns {Promise<void>}
 */
const startWorkflow = async ({ github, context, core, workflow_id, ref, inputs }) => {
	core.info(`Start workflow '${workflow_id}' using ref '${ref}' and inputs ${JSON.stringify(inputs)}.`);
  
	let response = null
	try {
	  response = await github.rest.actions.createWorkflowDispatch({
		owner: context.repo.owner,
		repo: context.repo.repo,
		workflow_id,
		ref,
		inputs: inputs || {},
	  });
	} catch(error) {
	  return core.setFailed(`Error triggering workflow_dispatch event: ${dumpError(error)}`)
	}
  
	core.debug(`status: ${response.status}`);
	core.debug(`workflow dispatch response: ${JSON.stringify(response)}`);
  
	if (response.status !== 204) {
	  return core.setFailed(`Error triggering workflow_dispatch event for '${workflow_id}'. createWorkflowDispatch response: ${JSON.stringify(response)}`);
	}
	return core.info(`Workflow '${workflow_id}' started successfully`);
};
module.exports.startWorkflow = startWorkflow;

/**
 * Get labels from PR and determine a workflow to run next.
 *
 * @param {object} inputs
 * @param {object} inputs.github - A pre-authenticated octokit/rest.js client with pagination plugins.
 * @param {object} inputs.context - An object containing the context of the workflow run.
 * @param {object} inputs.core - A reference to the '@actions/core' package.
 * @param {string} inputs.ref - A git ref to checkout head commit for PR (e.g. refs/pull/133/head).
 * @returns {Promise<void>}
 */
module.exports.runWorkflowForPullRequest = async ({ github, context, core, ref }) => {
  const event = context.payload;
  const label = event.label.name;
  const prNumber = context.payload.pull_request.number;
  const prLabels = context.payload.pull_request.labels;

  let userLabelsInPR = await checkUserClusterLabel({github, context, core, prLabels});
  if (userLabelsInPR.length === 0) {
    core.info('No user labels found in PR, using PR author\'s cluster');
    const prAuthor = context.payload.pull_request.user.login;
    core.info(`PR author: ${prAuthor}`);
    const authorLabel = [{'name': `e2e/user/${prAuthor}`}];
    // retry check for PR author's cluster label
    userLabelsInPR = await checkUserClusterLabel({github, context, core, prLabels: authorLabel});
    if (userLabelsInPR.length === 0) {
      return core.setFailed(`Error: PR author's cluster label not found`);
    }
  } else if (userLabelsInPR.length > 1) {
    return core.setFailed(`Error: PR has multiple user labels: ${userLabelsInPR.join(', ')}`);
  }

  core.startGroup(`Dump context`);
  core.info(`Git ref for workflows: ${ref}`);
  core.info(`PR number: ${prNumber}`);
  core.info(`PR action: ${event.action}`);
  core.info(`PR action label: '${label}'`);
  core.info(
    `Current labels: ${JSON.stringify(
      prLabels.map((l) => l.name),
      null,
      '  '
    )}`
  );
  core.info(`Known labels: ${JSON.stringify(knownLabels, null, '  ')}`);
  core.endGroup();

  // Note: no more auto rerun for validation.yml.

  let command = {
    // null - do nothing
    // true - pr labeled
    // false- pr unlabeled
    setE2eShouldSkipped: null,
    rerunWorkflow: false,
    triggerWorkflowDispatch: false,
    workflows: []
  };
  core.startGroup(`PR#${prNumber} was ${event.action} with '${label}'. Detect command ...`);
  try {
    const labelInfo = knownLabels[label];
    const labelType = labelInfo ? labelInfo.type : '';
    if (label === skipE2eLabel) {
      // set commit status
      command.setE2eShouldSkipped = event.action === 'labeled';
    }
    if (labelType === 'e2e-run' && event.action === 'labeled') {
      // Workflow will remove label from PR, ignore 'unlabeled' action.
      command.workflows = [`run-e2e-on-user-cluster.yml`];
      command.triggerWorkflowDispatch = true;
    }
    if (labelType === 'deploy-web' && event.action === 'labeled') {
      // Workflow will remove label from PR, ignore 'unlabeled' action.
      command.workflows = [`deploy-web-${labelInfo.env}.yml`];
      command.triggerWorkflowDispatch = true;
    }
  } finally {
    core.endGroup();
  }

  if (command.setE2eShouldSkipped !== null) {
    return e2eStatus.onLabeledForSkip({
      github,
      context,
      core,
      labeled: command.setE2eShouldSkipped,
      commitSha: context.payload.pull_request.head.sha
    });
  }

  if (command.workflows.length === 0) {
    return core.notice(`Ignore '${event.action}' event for label '${label}': no workflow to rerun.`);
  }

  if (command.rerunWorkflow) {
    core.notice(`Retry workflows '${JSON.stringify(command.workflows)}' for label '${label}'`);
    for (const workflow_id of command.workflows) {
      await findAndRerunWorkflow({ github, context, core, workflow_id });
    }
  }

  if (command.triggerWorkflowDispatch) {
    // Can trigger only single workflow because of commenting on PR.
    const workflow_id = command.workflows[0];
    core.notice(`Run workflow '${JSON.stringify(command.workflows)}' for label '${label}'`);
    core.startGroup(`Trigger workflow_dispatch event ...`);
    try {
      // Add a comment to pull request. https://docs.github.com/en/rest/issues/comments#create-an-issue-comment
      core.info(`Commenting on PR#${prNumber} ...`);
      const response = await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        body: commentLabelRecognition(context.payload.sender.login, label)
      });

      if (response.status !== 201) {
        return core.setFailed(`Error commenting PR#${prNumber}: ${JSON.stringify(response)}`);
      }

      // Triggering workflow_dispatch requires a ref to checkout workflows.
      // We use refs/heads/main for workflows and pass refs/pulls/head/NUM in
      // pull_request_ref field to checkout PR content.
      const targetRepo = context.payload.repository.full_name;
      const prRepo = context.payload.pull_request.head.repo.full_name;
      const prRef = context.payload.pull_request.head.ref;
      const prInfo = {
        ci_commit_ref_name: prRepo === targetRepo ? prRef : `pr${prNumber}`,
        pull_request_ref: ref,
        pull_request_sha: context.payload.pull_request.head.sha,
        pull_request_head_label: context.payload.pull_request.head.label
      };

      core.debug(`Pull request info: ${JSON.stringify(prInfo)}`);
      core.info(`Username: ${userLabelsInPR.user}`);
      await startWorkflow({
        github,
        context,
        core,
        workflow_id,
        ref: 'refs/heads/main',
        inputs: {
          username: userClusterLabels[userLabelsInPR].user
        }
      });
    } catch (error) {
      core.info(`Github API call error: ${dumpError(error)}; (${JSON.stringify(error)})`);
    } finally {
      core.endGroup();
    }
  }
}; 