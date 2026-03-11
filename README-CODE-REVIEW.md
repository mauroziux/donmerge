# 🤖 Codex Code Review Assistant

An AI-powered code review assistant that provides automated, line-specific feedback on pull requests using Codex AI. Designed to work seamlessly with **GitHub private repositories**.

## ✨ Features

- **Automatic PR Reviews**: Triggers on PR creation and updates
- **Manual Re-trigger**: Re-run reviews by commenting `@codereview`
- **Line-Specific Comments**: Provides feedback on exact lines in the diff
- **GitHub Check Runs**: Creates actionable check runs with pass/fail status
- **Critical Issue Detection**: Fails PRs with security vulnerabilities, logic errors, or breaking changes
- **Configurable Base Branch**: Works with any base branch (default: `main`)
- **Private Repository Support**: Secure handling of private code
- **Codex Integration**: Uses Codex-5.2 or Codex-5.3 for intelligent code analysis

## 🚀 Quick Start

### Prerequisites

- GitHub repository (public or private)
- OpenAI API key with access to Codex models
- Node.js 22+ (for local testing)

### 1. Add Required Secrets

Navigate to your repository settings:

```
Settings → Secrets and variables → Actions → New repository secret
```

Add these secrets:

| Secret Name | Description | How to Get |
|-------------|-------------|------------|
| `OPENAI_API_KEY` | OpenAI API key for Codex | [Get from OpenAI](https://platform.openai.com/api-keys) |

### 2. Configure Repository Variables (Optional)

Navigate to:

```
Settings → Secrets and variables → Actions → Variables
```

| Variable Name | Default | Description |
|--------------|---------|-------------|
| `CODEX_MODEL` | `codex-5.3` | Codex model to use (`codex-5.2` or `codex-5.3`) |
| `BASE_BRANCH` | `main` | Target branch for reviews |
| `MAX_REVIEW_FILES` | `50` | Maximum files to review per PR |
| `AUTO_REVIEW_ON_PR` | `true` | Enable automatic reviews on PR creation |
| `FAIL_ON_CRITICAL` | `true` | Fail check on critical issues |
| `REVIEW_TIMEOUT` | `300` | Review timeout in seconds |
| `CUSTOM_REVIEW_INSTRUCTIONS` | `""` | Domain-specific review guidance |
| `SKIP_PATTERNS` | `*.test.ts,*.spec.ts` | Files to skip during review |
| `LOG_LEVEL` | `info` | Logging verbosity |

### 3. Verify Setup

1. Open a new pull request targeting your configured base branch
2. The review should trigger automatically
3. Check the "Actions" tab for workflow progress
4. Review results appear as:
   - Check run in the PR checks section
   - Line-specific comments on the diff
   - Summary comment with statistics

### 4. Manual Re-trigger

To re-run a review (e.g., after fixing issues):

```
@codereview
```

Comment this on any PR to trigger a new review.

## 📖 Usage

### Automatic Review

Reviews trigger automatically when:
- PR is **opened**
- PR receives **new commits** (synchronize)
- PR is **reopened**

**Note**: Only reviews PRs targeting the configured `BASE_BRANCH`.

### Manual Review

Comment on any PR:

```
@codereview
```

Additional context (optional):

```
@codereview

Please focus on security vulnerabilities and performance issues.
```

### Review Output

#### Check Run Status

| Status | Meaning |
|--------|---------|
| ✅ **Success** | No critical issues found, PR is safe to merge |
| ❌ **Failure** | Critical issues detected, review required |
| ⏱️ **Timed Out** | Review exceeded maximum duration |
| ⚠️ **Partial** | Large PR, only critical files reviewed |

#### Line Comments

- 🔴 **Critical**: Blocking issues (security, logic errors, breaking changes)
- 💡 **Suggestions**: Non-blocking improvements (code quality, best practices)

### Example Review

```markdown
## ✅ Code Review Passed

This PR implements user authentication with proper security practices.

### 📊 Review Statistics
- **Files Reviewed**: 5
- **Critical Issues**: 0
- **Suggestions**: 3

### 💡 Suggestions
- Consider adding rate limiting to the login endpoint
- Add JSDoc comments to public functions
- Extract validation logic to a separate module
```

## ⚙️ Configuration

### Environment Variables

Create `.env` file (use `.env.example` as template):

```bash
# Required
OPENAI_API_KEY=sk-...

# Optional (with defaults)
CODEX_MODEL=codex-5.3
BASE_BRANCH=main
MAX_REVIEW_FILES=50
AUTO_REVIEW_ON_PR=true
FAIL_ON_CRITICAL=true
REVIEW_TIMEOUT=300
LOG_LEVEL=info
```

### GitHub Actions Permissions

The workflow requires these permissions:

```yaml
permissions:
  contents: read        # Read repository contents
  pull-requests: write  # Post review comments
  checks: write         # Create check runs
  issues: read          # Read PR metadata
```

### Branch Protection

To enforce code reviews:

1. Go to **Settings → Branches → Branch protection rules**
2. Add rule for your base branch
3. Enable "Require status checks to pass before merging"
4. Select "Codex Code Review" check

## 🔧 Advanced Customization

### Custom Review Instructions

Add domain-specific guidance:

**Repository Variable**: `CUSTOM_REVIEW_INSTRUCTIONS`

```markdown
Focus on:
- Security vulnerabilities (OWASP Top 10)
- Performance issues (N+1 queries, memory leaks)
- Healthcare data privacy (HIPAA compliance)
- Error handling for external API calls
```

### Skip Patterns

Exclude files from review:

**Repository Variable**: `SKIP_PATTERNS`

```bash
*.test.ts,*.spec.ts,*.generated.ts,dist/**,build/**,vendor/**
```

### Multiple Base Branches

To review PRs targeting different branches:

1. **Option A**: Create separate workflow files
   ```yaml
   # .github/workflows/code-review-develop.yml
   on:
     pull_request:
       branches: [develop]
   ```

2. **Option B**: Use repository variable
   ```
   BASE_BRANCH=develop
   ```

### Model Selection

Choose between Codex versions:

| Model | Strengths | Use Case |
|-------|-----------|----------|
| `codex-5.2` | Balanced speed and accuracy | General code review |
| `codex-5.3` | Enhanced security detection | Security-critical projects |

## 🐛 Troubleshooting

### Review Not Triggering

**Symptoms**: No review on PR creation

**Solutions**:
1. Check workflow is enabled in Actions tab
2. Verify `AUTO_REVIEW_ON_PR` is `true`
3. Confirm PR targets the correct base branch
4. Check Actions logs for errors

### Authentication Errors

**Symptoms**: "Permission denied" or "Unauthorized"

**Solutions**:
1. Verify `OPENAI_API_KEY` secret is set correctly
2. Check API key has access to Codex models
3. Ensure API key hasn't expired
4. Verify `GITHUB_TOKEN` permissions in workflow

### No Line Comments

**Symptoms**: Review completes but no comments on diff

**Solutions**:
1. Check if files exceed `MAX_REVIEW_FILES` limit
2. Verify files aren't matched by `SKIP_PATTERNS`
3. Review workflow logs for API errors
4. Ensure PR has actual code changes (not just renames)

### Check Run Not Created

**Symptoms**: Review runs but no check appears

**Solutions**:
1. Verify workflow has `checks: write` permission
2. Check if repository has branch protection enabled
3. Look for errors in workflow logs
4. Ensure `GITHUB_TOKEN` is provided

### Timeout Errors

**Symptoms**: "Review exceeded maximum duration"

**Solutions**:
1. Increase `REVIEW_TIMEOUT` variable
2. Reduce `MAX_REVIEW_FILES` to limit scope
3. Add more files to `SKIP_PATTERNS`
4. Consider breaking large PRs into smaller ones

### Private Repository Issues

**Symptoms**: Can't access private repo code

**Solutions**:
1. Workflow runs in your repository context (has access)
2. Ensure `GITHUB_TOKEN` is not restricted
3. Check repository visibility settings
4. Verify workflow has `contents: read` permission

## 🔒 Security Considerations

### Data Privacy

- ✅ Code diffs processed only in GitHub Actions environment
- ✅ No external data persistence beyond OpenAI API
- ✅ Logs sanitized to remove sensitive information
- ✅ API keys stored securely in GitHub Secrets

### Access Control

- ✅ Uses minimal required permissions
- ✅ `GITHUB_TOKEN` automatically scoped to repository
- ✅ No additional OAuth or app installation required
- ✅ Respects branch protection rules

### Best Practices

1. **Limit API Key Scope**: Use separate OpenAI API keys per project
2. **Review Permissions**: Audit workflow permissions regularly
3. **Monitor Usage**: Track API usage to detect anomalies
4. **Rotate Secrets**: Periodically rotate API keys
5. **Audit Logs**: Review Actions logs for suspicious activity

## 📊 Monitoring

### Workflow Metrics

Track in GitHub Actions:
- Review duration
- Success/failure rate
- API call frequency

### API Usage

Monitor OpenAI API usage:
```bash
curl https://api.openai.com/v1/usage \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

### Logging

Adjust verbosity with `LOG_LEVEL`:
- `debug`: Detailed execution logs
- `info`: General progress (default)
- `warn`: Warnings only
- `error`: Errors only

## 🤝 Contributing

### Local Development

```bash
# Clone repository
git clone https://github.com/your-org/your-repo.git
cd your-repo

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Test workflow locally
npx flue run .flue/workflows/code-review.ts \
  --args '{"prNumber": 123, "baseBranch": "main"}' \
  --model codex-5.3
```

### Testing Changes

1. Create test PR in development repository
2. Trigger review with `@codereview`
3. Verify output and behavior
4. Check all edge cases (large PRs, binary files, etc.)

## 📝 License

MIT License - See LICENSE file for details

## 🆘 Support

- **Documentation**: This file
- **Issues**: Open a GitHub issue
- **Discussions**: GitHub Discussions for questions
- **Security Issues**: Email security@your-org.com

## 🗺️ Roadmap

- [ ] Support for GitLab repositories
- [ ] Integration with SonarQube
- [ ] Custom rule sets per repository
- [ ] Batch review for multiple PRs
- [ ] Slack/Teams notifications
- [ ] Review analytics dashboard

---

**Built with ❤️ using Flue and Codex AI**
