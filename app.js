import React, { useState, useEffect, useCallback, useRef } from 'react';
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

// Helper function to recursively extract text from a DocumentNode structure
function extractTextFromNode(node) {
  if (!node) return "";
  let result = "";

  if (node.type === "text" && typeof node.text === "string") {
    result += node.text;
  }

  // Recursively process children if they exist
  if (node.children && Array.isArray(node.children)) {
    node.children.forEach(child => {
      result += extractTextFromNode(child);
      // Add paragraph breaks for block elements
      if (child.type === "paragraph" || child.type === "list_item" || child.type === "break") {
        result += "\n";
      } else if (child.type !== "text" && child.type !== "document") { 
        // Add space for other non-text inline elements to avoid words sticking together,
        // but not after the entire document or a text node itself.
        const nextCharIsSpaceOrNewline = result.match(/[\s\n]$/);
        if(!nextCharIsSpaceOrNewline) {
            result += " ";
        }
      }
    });
  }
  
  // Example: Handle link nodes if they don't have children or you want to add the URL
  // if (node.type === "link" && (!node.children || node.children.length === 0) && node.url) {
  //   result += ` ${node.url} `;
  // }

  return result;
}

// Wrapper function to parse DocumentNode and clean up the extracted text
function getTextFromDocumentNodeImproved(docNode) {
  if (!docNode || docNode.type !== "document" || !docNode.children) {
    // Try to handle if it's not a full document node but just a part
    if (docNode && docNode.children && Array.isArray(docNode.children)) {
      // Fallback for partial structures if needed, or just return ""
    } else if (docNode && docNode.type === 'paragraph') {
       // If it's just a paragraph node, process it
    } else {
      return "";
    }
  }
  
  let rawText = extractTextFromNode(docNode);
  // Clean up: replace multiple newlines with a single one, and trim spaces around newlines.
  rawText = rawText.replace(/\s*\n\s*/g, "\n").trim();
  // Replace multiple spaces with a single space
  rawText = rawText.replace(/ +/g, " ");
  return rawText;
}

function App() {
  const [isSyncing, setIsSyncing] = useState(true); // For UI feedback
  const [syncError, setSyncError] = useState(null);
  const syncInProgressRef = useRef(false); // Functional lock for sync operation

  const syncMetadataComments = useCallback(async () => {
    if (syncInProgressRef.current) {
      console.log("Sync operation already in progress. Skipping this interval call.");
      return;
    }
    syncInProgressRef.current = true;
    setIsSyncing(true); 
    setSyncError(null); // Clear previous sync error before a new attempt

    try {
      console.log("Attempting to sync metadata comments...");
      if (window.websim && window.websim.metadata) {
        // Log a stringified version for easier inspection of the structure
        try {
            console.log("Current window.websim.metadata structure:", JSON.stringify(window.websim.metadata, null, 2));
        } catch (e) {
            console.warn("Could not stringify window.websim.metadata (circular refs?):", window.websim.metadata);
        }
      } else {
        console.log("window.websim or window.websim.metadata is not available at this time.");
      }

      const metadataComments = window.websim?.metadata?.comments;

      if (!metadataComments) {
          console.warn("window.websim.metadata.comments is not found. No comments to sync.");
          // setIsSyncing(false) will be handled in finally
          syncInProgressRef.current = false; // Release lock early if no comments object
          setIsSyncing(false); // Update UI
          return;
      }
      if (!Array.isArray(metadataComments)) {
          console.warn("window.websim.metadata.comments is not an array. Structure:", metadataComments);
          setSyncError("Metadata comments are not in the expected array format.");
          syncInProgressRef.current = false; // Release lock
          setIsSyncing(false); // Update UI
          return;
      }
      if (metadataComments.length === 0) {
          console.log("No metadata comments found to sync.");
          syncInProgressRef.current = false; // Release lock
          setIsSyncing(false); // Update UI
          return;
      }

      console.log(`Found ${metadataComments.length} metadata comments to process.`);

      for (const mc of metadataComments) {
        if (!mc || typeof mc !== 'object') {
          console.warn("Skipping invalid metadata comment (not an object):", mc);
          continue;
        }
        if (!mc.id || !mc.author || !mc.author.id || !mc.author.username || !mc.created_at) {
          console.warn("Skipping malformed metadata comment (missing essential fields): id, author.id, author.username, created_at. Comment data:", mc);
          continue;
        }
        
        let contentToStore = mc.raw_content;
        if (contentToStore == null) { // Checks for null or undefined
          if (mc.content) {
            contentToStore = getTextFromDocumentNodeImproved(mc.content);
            if (!contentToStore && mc.content.children && mc.content.children.length > 0) {
              contentToStore = "[Content structure present, but no text extracted or content is empty]";
            } else if (!contentToStore) {
              contentToStore = "[No textual content found in content object]";
            }
          } else {
            contentToStore = "[No raw_content or content field provided]";
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
      syncInProgressRef.current = false;
    }
  }, []); // Dependencies: setIsSyncing, setSyncError are stable. syncInProgressRef is stable. COLLECTION_NAME is const.

  useEffect(() => {
    const performInitialAndIntervalSync = () => {
      syncMetadataComments();
    };

    performInitialAndIntervalSync(); // Perform initial sync

    const intervalId = setInterval(performInitialAndIntervalSync, 7000); // Sync every 7 seconds
    
    return () => {
      clearInterval(intervalId); // Cleanup interval on component unmount
    };
  }, [syncMetadataComments]); // Add syncMetadataComments as a dependency.

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