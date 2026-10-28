# omp extensions

Live AWS watcher cards for [oh-my-pi](https://github.com/can1357/oh-my-pi): CodeBuild logs, CloudFormation stack events for CDK deployments, and CodePipeline execution progress. Cards appear above the editor and run in the background, so you and the agent can keep working.

## Install

Requires omp (verified with 18.13.3), Git, and the AWS CLI on your `PATH`.

```sh
omp plugin install github:kairisameshima/omp-extensions
```

Restart omp after installing. The package registers `/cbwatch`, `/cfnwatch`, and `/cpwatch`, plus the `codebuild_watch`, `cloudformation_watch`, and `codepipeline_watch` tools. No separate npm install or build step is needed. omp provides the extension's runtime imports.

If you already have a standalone `codebuild-watch.ts` in `~/.omp/agent/extensions/` or a project's `.omp/extensions/`, move it outside the extensions directory before restarting to avoid duplicate registrations.

To try a local checkout instead:

```sh
git clone https://github.com/kairisameshima/omp-extensions.git
omp plugin link ./omp-extensions
```

To update or remove the installed package:

```sh
omp plugin upgrade @kairisameshima/omp-extensions
omp plugin uninstall @kairisameshima/omp-extensions
```

Linked checkouts use local source changes directly and do not support `plugin upgrade`.

## AWS access

The watchers use your AWS CLI credentials and region configuration, including environment variables such as `AWS_PROFILE` and `AWS_REGION`. Pass `--profile` and `--region` to override your configuration for a watch.

For SSO profiles, authenticate first:

```sh
aws sso login --profile engineering
```

Your identity needs `codebuild:BatchGetBuilds` and `logs:GetLogEvents` for the watched build and its CloudWatch log stream. Watching by project also requires `codebuild:ListBuildsForProject`. The watcher only reads AWS resources.

CloudFormation watches require `cloudformation:DescribeStacks` and `cloudformation:DescribeStackEvents`. CodePipeline watches require `codepipeline:ListPipelineExecutions` when selecting the newest execution, plus `codepipeline:GetPipelineExecution` and `codepipeline:ListActionExecutions`.

## Usage

Watch a specific build:

```text
/cbwatch my-project:00000000-0000-0000-0000-000000000000
```

Watch a project's newest build:

```text
/cbwatch my-project --profile engineering --region us-west-2
```

Wait for a build matching a commit SHA prefix:

```text
/cbwatch my-project abc1234 --profile engineering --region us-west-2
```

You can also ask the agent to watch a build. Its `codebuild_watch` tool accepts `build_id`, or `project` with an optional `source_version` SHA prefix, plus optional `profile` and `region` overrides.

### CDK and CloudFormation

Watch the deployed CloudFormation stack name or stack ARN:

```text
/cfnwatch my-app-stack --profile engineering --region us-west-2
```

The card shows stack status and the eight newest resource events, including failure reasons. For CDK, use the deployed stack name, not a construct path. The watcher observes CloudFormation only. It does not launch `cdk deploy` or monitor local synthesis and asset uploads. Start one watch per stack.

The `cloudformation_watch` tool accepts `stack`, plus optional `profile` and `region`. A stack that does not exist yet is watched until it appears. Once found, its stack ID is pinned. An existing stack already in a terminal state completes immediately, so start the watch after the update begins when reusing a stack. Rollback completion is reported as a failed deployment, not success.

### CodePipeline

Watch the newest execution, or pin a specific execution:

```text
/cpwatch my-pipeline --profile engineering --region us-west-2
/cpwatch my-pipeline 00000000-0000-0000-0000-000000000000
```

The card shows the selected execution's stage and action statuses. The `codepipeline_watch` tool accepts `pipeline`, optional `execution_id`, and optional `profile` and `region`. Without an execution ID, it waits for an execution if none exists, then pins the newest one. It does not switch to newer runs. Final results include failed action details.

Both new watchers poll every five seconds and stop after two hours from starting the watch. AWS errors appear in the card while polling continues. Their panel keys include profile and region. When finished, they remove the live card and post a result message. Agent-started watches wake an idle agent, while slash-command watches do not.

## CodeBuild behavior and limits

The watcher polls every five seconds and stops watching after two hours. Project watches search the ten newest builds. A commit watch keeps polling until a matching build appears. Distinct build IDs or project/SHA targets can be watched together. Avoid starting the same target twice, including in different accounts or regions, because its panel key does not include the AWS profile or region.

When a build ends, the panel is removed and a result message reports its status and any failed phase. An agent-started watch wakes the idle agent. A `/cbwatch` watch displays the result without starting an idle agent turn. Final messages do not include the log tail.

AWS errors appear in the panel, and polling continues so refreshing expired credentials can resume the watch. CloudWatch logs must be enabled on the build to display log output. Watches belong to the current omp session and do not survive restarting omp.
