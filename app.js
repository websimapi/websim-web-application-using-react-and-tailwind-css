import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { WebsimSocket, useQuery } from '@websim/use-query';

const SCHEMA_VERSION = 'v1';
const COLLECTION_NAME = `synced_page_comments_${SCHEMA_VERSION}`;

const room = new WebsimSocket({
  schema: {
    [COLLECTION_NAME]: {
      id: "text", // Primary key: original metadata comment ID
      raw_content: "text",
      author_id: "text", // Original author's user ID
      author_username: "text", // Original author's username
      metadata_created_at: "timestamptz", // Original comment creation timestamp
    },
  },
});

// Helper to get a simple text representation from DocumentNode
// This is a basic implementation. A more robust one would traverse the node tree.
function getTextFromDocumentNode(node) {
  if (!node || !node.children || !Array.isArray(node.children)) {
    return "";
  }
  let text = "";
  try {
    for (const child of node.children) {
      if (child.type === "paragraph" && child.children) {
        for (const pChild of child.children) {
          if (pChild.type === "text" && pChild.text) {
            text += pChild.text + "\n";
          }
        }
      }
    }
  } catch (e) {
    console.warn("Error parsing DocumentNode content:", e);
    return JSON.stringify(node); // Fallback to stringified JSON
  }
  return text.trim();
}

function App() {
  const [isSyncing, setIsSyncing] = useState(true); // Initialize to true for the first sync
  const [syncError, setSyncError] = useState(null);

  // syncMetadataComments is defined here, outside useEffect, so it's stable.
  // It already handles setting setIsSyncing(false) in its finally block and setSyncError on error.
  const syncMetadataComments = async () => {
    try {
      console.log("Attempting to sync metadata comments...");
      const metadataComments = window.websim?.metadata?.comments;

      if (!metadataComments) {
          console.warn("window.websim.metadata.comments is not found. No comments to sync.");
          // Don't set isSyncing here, let the caller's finally block do it.
          return;
      }
      if (!Array.isArray(metadataComments)) {
          console.warn("window.websim.metadata.comments is not an array. Structure:", metadataComments);
          setSyncError("Metadata comments are not in the expected array format.");
          return;
      }
      if (metadataComments.length === 0) {
          console.log("No metadata comments found to sync.");
          return;
      }

      console.log(`Found ${metadataComments.length} metadata comments to process.`);

      for (const mc of metadataComments) {
        if (!mc || typeof mc !== 'object') {
          console.warn("Skipping invalid metadata comment (not an object):", mc);
          continue;
        }
        if (!mc.id || !mc.author || !mc.author.id || !mc.author.username || !mc.created_at) {
          console.warn("Skipping malformed metadata comment (missing essential fields):", mc);
          continue;
        }
        
        let contentToStore = mc.raw_content;
        if (contentToStore == null) { // Checks for null or undefined
          if (mc.content) {
            contentToStore = getTextFromDocumentNode(mc.content) || "[Content not parsable]";
          } else {
            contentToStore = "[No content]";
          }
        }

        const commentData = {
          id: mc.id.toString(), // Ensure ID is a string
          raw_content: contentToStore,
          author_id: mc.author.id.toString(),
          author_username: mc.author.username.toString(),
          metadata_created_at: mc.created_at,
        };
        await room.collection(COLLECTION_NAME).upsert(commentData);
      }
      console.log("Finished syncing metadata comments.");
    } catch (error) {
      console.error("Error syncing metadata comments:", error);
      setSyncError(`Failed to sync comments: ${error.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    const performSyncOperation = async () => {
      setSyncError(null); // Clear previous sync error
      setIsSyncing(true); // Indicate that a sync operation is starting
      await syncMetadataComments(); 
    };

    performSyncOperation(); // Perform initial sync

    const intervalId = setInterval(performSyncOperation, 7000); // Sync every 7 seconds
    
    return () => {
      clearInterval(intervalId); // Cleanup interval on component unmount
    };
  }, []); // Empty dependency array: runs once on mount, cleans up on unmount.

  const { data: syncedComments, loading: loadingDbComments, error: queryError } = useQuery(
    room.query(
      `SELECT 
        c.id, 
        c.raw_content, 
        c.author_id, 
        c.author_username, 
        c.metadata_created_at
      FROM public.${COLLECTION_NAME} c
      ORDER BY c.metadata_created_at ASC`
    )
  );
  
  const displayError = syncError || (queryError ? `Failed to load comments from DB: ${queryError.message}` : null);

  return (
    <div className="container mx-auto p-4 sm:p-6 lg:p-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Page Comments</h1>
      </header>
      
      {isSyncing && (
        <div className="bg-blue-100 border-l-4 border-blue-500 text-blue-700 p-4 mb-6" role="status">
          <p className="font-bold">Processing Comments</p>
          <p>Syncing comments from page metadata into the database. Please wait...</p>
        </div>
      )}

      {!isSyncing && displayError && (
         <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6" role="alert">
          <p className="font-bold">Error Occurred</p>
          <p>{displayError}</p>
        </div>
      )}
      
      {!isSyncing && !displayError && (
        loadingDbComments && (!syncedComments || syncedComments.length === 0) ? (
          <div className="text-gray-600">Loading comments from database...</div>
        ) : (
          syncedComments && syncedComments.length > 0 ? (
            <div className="space-y-4">
              {syncedComments.map((comment) => (
                <CommentItem key={comment.id} comment={comment} />
              ))}
            </div>
          ) : (
            <div className="text-gray-600 text-center py-8">
              <p className="text-xl">No comments to display.</p>
              <p className="text-sm">Either no comments were found on the page or syncing is complete.</p>
            </div>
          )
        )
      )}
    </div>
  );
}

function CommentItem({ comment }) {
  const avatarUrl = comment.author_username ? `https://images.websim.com/avatar/${comment.author_username}` : 'https://images.websim.com/avatar/default';
  const profileUrl = comment.author_username ? `https://websim.com/@${comment.author_username}` : '#';
  
  let formattedDate = 'Date unknown';
  try {
    if (comment.metadata_created_at) {
      formattedDate = new Date(comment.metadata_created_at).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    }
  } catch (e) {
    console.warn("Failed to parse date:", comment.metadata_created_at, e);
  }


  return (
    <article className="bg-white shadow-lg rounded-xl p-4 sm:p-5 border border-gray-200 hover:shadow-xl transition-shadow duration-200">
      <div className="flex items-start space-x-3 sm:space-x-4">
        <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
          <img 
            src={avatarUrl} 
            alt={comment.author_username ? `${comment.author_username}'s avatar` : 'Default avatar'}
            className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gray-300 object-cover border-2 border-gray-100"
            onError={(e) => { e.target.src = 'https://images.websim.com/avatar/default'; }} // Fallback avatar
          />
        </a>
        <div className="flex-1 min-w-0"> {/* Added min-w-0 for text overflow handling */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-1">
            <a href={profileUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-gray-900 hover:text-blue-600 hover:underline truncate">
              @{comment.author_username || 'Unknown User'}
            </a>
            <time dateTime={comment.metadata_created_at} className="text-xs text-gray-500 mt-1 sm:mt-0">
              {formattedDate}
            </time>
          </div>
          <p className="text-gray-700 text-sm sm:text-base whitespace-pre-wrap break-words">
            {comment.raw_content || "[Empty comment]"}
          </p>
        </div>
      </div>
    </article>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);