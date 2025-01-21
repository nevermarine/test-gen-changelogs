#!/bin/bash

# milestone="v1.7.0"

if [ -z "${milestone}" ]; then
    echo 'Set $milestone var'
    exit 1
fi

# Function to check for errors and exit if any occur
check_error() {
    if [ $? -ne 0 ]; then
        echo "Error: $1"
        exit 1
    fi
}

# Generate a random branch name
branch_name="branch_$(date +%s)"
echo "Generated random branch name: $branch_name."

# Create and switch to the new branch
git checkout -b "$branch_name"
check_error "Failed to create or switch to branch $branch_name."

echo "Switched to branch $branch_name."

# Create a random empty file
random_file="file_$(date +%s).txt"
touch "$random_file"
check_error "Failed to create file $random_file."

echo "Created empty file: $random_file."

# Stage the file
git add "$random_file"
check_error "Failed to stage file $random_file."

# Commit the file
git commit -m "feat(core): add file $random_file"
check_error "Failed to commit changes."

echo "Committed $random_file to branch $branch_name."

# Push the branch and set the upstream
git push --set-upstream origin "$branch_name"
check_error "Failed to push branch $branch_name to origin."

echo "Branch $branch_name has been pushed and published."

git checkout main

echo "Creating a pull request..."
gh pr create --title "fix(core): add file $branch_name" --body 'Automatic fix

```changes
section: core
type: fix
summary: add made up fix
```
' --base main --head "$branch_name" 
# --label 'status/backport'
check_error "Failed to create pull request."

echo "Pull request created for branch $branch_name."

# Assign a milestone to the PR
echo "Assigning milestone to the pull request..."
gh pr edit "$branch_name" --milestone "$milestone"
check_error "Failed to assign milestone to pull request."

echo "Milestone assigned to the pull request."

sleep 5

# Merge the pull request
echo "Merging the pull request..."
gh pr merge "$branch_name" --squash --delete-branch
check_error "Failed to merge pull request and delete branch."

echo "Pull request merged and branch deleted."

exit 0
